/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/*
 * Copyright (C) 2023 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { URI as Uri } from 'vscode-uri';
import * as lsp from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CommandTypes } from '../ts-protocol.js';
import type { ts } from '../ts-protocol.js';
import { ClientCapability, ITypeScriptServiceClient } from '../typescriptService.js';
import API from '../utils/api.js';
import { coalesce } from '../utils/arrays.js';
import { Delayer, setImmediate } from '../utils/async.js';
// import { nulToken } from '../utils/cancellation';
import { Disposable } from '../utils/dispose.js';
import * as languageModeIds from '../utils/languageIds.js';
import { ResourceMap } from '../utils/resourceMap.js';
import * as typeConverters from '../utils/typeConverters.js';

const enum BufferKind {
    TypeScript = 1,
    JavaScript = 2,
}

const enum BufferState {
    Initial = 1,
    Open = 2,
    Closed = 2,
}

function mode2ScriptKind(mode: string): 'TS' | 'TSX' | 'JS' | 'JSX' | undefined {
    switch (mode) {
        case languageModeIds.typescript: return 'TS';
        case languageModeIds.typescriptreact: return 'TSX';
        case languageModeIds.javascript: return 'JS';
        case languageModeIds.javascriptreact: return 'JSX';
    }
    return undefined;
}

const enum BufferOperationType { Close, Open, Change }

class CloseOperation {
    readonly type = BufferOperationType.Close;
    constructor(
        public readonly args: string,
    ) { }
}

class OpenOperation {
    readonly type = BufferOperationType.Open;
    constructor(
        public readonly args: ts.server.protocol.OpenRequestArgs,
    ) { }
}

class ChangeOperation {
    readonly type = BufferOperationType.Change;
    constructor(
        public readonly args: ts.server.protocol.FileCodeEdits,
    ) { }
}

type BufferOperation = CloseOperation | OpenOperation | ChangeOperation;

/**
 * Manages synchronization of buffers with the TS server.
 *
 * If supported, batches together file changes. This allows the TS server to more efficiently process changes.
 */
class BufferSynchronizer {
    private readonly _pending: ResourceMap<BufferOperation>;

    constructor(
        private readonly client: ITypeScriptServiceClient,
        pathNormalizer: (path: Uri) => string | undefined,
        onCaseInsensitiveFileSystem: boolean,
    ) {
        this._pending = new ResourceMap<BufferOperation>(pathNormalizer, {
            onCaseInsensitiveFileSystem,
        });
    }

    public open(resource: Uri, args: ts.server.protocol.OpenRequestArgs) {
        if (this.supportsBatching) {
            this.updatePending(resource, new OpenOperation(args));
        } else {
            this.client.executeWithoutWaitingForResponse(CommandTypes.Open, args);
        }
    }

    /**
     * @return Was the buffer open?
     */
    public close(resource: Uri, filepath: string): boolean {
        if (this.supportsBatching) {
            return this.updatePending(resource, new CloseOperation(filepath));
        } else {
            const args: ts.server.protocol.FileRequestArgs = { file: filepath };
            this.client.executeWithoutWaitingForResponse(CommandTypes.Close, args);
            return true;
        }
    }

    public change(resource: Uri, filepath: string, events: readonly lsp.TextDocumentContentChangeEvent[]) {
        if (!events.length) {
            return;
        }

        if (this.supportsBatching) {
            const edits: ts.server.protocol.CodeEdit[] = [];
            // TODO: lsp.TextDocumentContentChangeEvent.isIncremental(event)
            for (const change of events) {
                if (!('range' in change)) {
                    // Not expecting any events without range.
                    continue;
                }
                edits.push({
                    newText: change.text,
                    start: typeConverters.Position.toLocation(change.range.start),
                    end: typeConverters.Position.toLocation(change.range.end),
                });
            }
            this.updatePending(resource, new ChangeOperation({
                fileName: filepath,
                textChanges: edits.reverse(), // Send the edits end-of-document to start-of-document order
            }));
        } else {
            for (const change of events) {
                if (!('range' in change)) {
                    // Not expecting any events without range.
                    continue;
                }
                const args: ts.server.protocol.ChangeRequestArgs = {
                    insertString: change.text,
                    ...typeConverters.Range.toFormattingRequestArgs(filepath, change.range),
                };
                this.client.executeWithoutWaitingForResponse(CommandTypes.Change, args);
            }
        }
    }

    public reset(): void {
        this._pending.clear();
    }

    public beforeCommand(command: string): void {
        if (command === 'updateOpen') {
            return;
        }

        this.flush();
    }

    private flush() {
        if (!this.supportsBatching) {
            // We've already eagerly synchronized
            this._pending.clear();
            return;
        }

        if (this._pending.size > 0) {
            const closedFiles: string[] = [];
            const openFiles: ts.server.protocol.OpenRequestArgs[] = [];
            const changedFiles: ts.server.protocol.FileCodeEdits[] = [];
            for (const change of this._pending.values) {
                switch (change.type) {
                    case BufferOperationType.Change: changedFiles.push(change.args); break;
                    case BufferOperationType.Open: openFiles.push(change.args); break;
                    case BufferOperationType.Close: closedFiles.push(change.args); break;
                }
            }
            this.client.execute(CommandTypes.UpdateOpen, { changedFiles, closedFiles, openFiles }, nulToken, { nonRecoverable: true });
            this._pending.clear();
        }
    }

    private get supportsBatching(): boolean {
        return this.client.apiVersion.gte(API.v340);
    }

    private updatePending(resource: Uri, op: BufferOperation): boolean {
        switch (op.type) {
            case BufferOperationType.Close: {
                const existing = this._pending.get(resource);
                switch (existing?.type) {
                    case BufferOperationType.Open:
                        this._pending.delete(resource);
                        return false; // Open then close. No need to do anything
                }
                break;
            }
        }

        if (this._pending.has(resource)) {
            // we saw this file before, make sure we flush before working with it again
            this.flush();
        }
        this._pending.set(resource, op);
        return true;
    }
}

class SyncedBuffer {
    private state = BufferState.Initial;

    constructor(
        private readonly document: TextDocument,
        public readonly filepath: string,
        private readonly client: ITypeScriptServiceClient,
        private readonly synchronizer: BufferSynchronizer,
    ) { }

    public open(): void {
        const args: ts.server.protocol.OpenRequestArgs = {
            file: this.filepath,
            fileContent: this.document.getText(),
            projectRootPath: this.client.getWorkspaceRootForResource(this.document.uri),
        };

        const scriptKind = mode2ScriptKind(this.document.languageId);
        if (scriptKind) {
            args.scriptKindName = scriptKind;
        }

        // const tsPluginsForDocument = this.client.pluginManager.plugins
        //     .filter(x => x.languages.indexOf(this.document.languageId) >= 0);

        // if (tsPluginsForDocument.length) {
        //     (args as any).plugins = tsPluginsForDocument.map(plugin => plugin.name);
        // }

        this.synchronizer.open(this.resource, args);
        this.state = BufferState.Open;
    }

    public get resource(): Uri {
        // TODO: This should perhaps be optimized if called often.
        return Uri.parse(this.document.uri);
    }

    public get lineCount(): number {
        return this.document.lineCount;
    }

    public get kind(): BufferKind {
        switch (this.document.languageId) {
            case languageModeIds.javascript:
            case languageModeIds.javascriptreact:
                return BufferKind.JavaScript;

            case languageModeIds.typescript:
            case languageModeIds.typescriptreact:
            default:
                return BufferKind.TypeScript;
        }
    }

    /**
     * @return Was the buffer open?
     */
    public close(): boolean {
        if (this.state !== BufferState.Open) {
            this.state = BufferState.Closed;
            return false;
        }
        this.state = BufferState.Closed;
        return this.synchronizer.close(this.resource, this.filepath);
    }

    public onContentChanged(events: readonly lsp.TextDocumentContentChangeEvent[]): void {
        if (this.state !== BufferState.Open) {
            console.error(`Unexpected buffer state: ${this.state}`);
        }

        this.synchronizer.change(this.resource, this.filepath, events);
    }
}

class SyncedBufferMap extends ResourceMap<SyncedBuffer> {
    public getForPath(filePath: string): SyncedBuffer | undefined {
        return this.get(Uri.file(filePath));
    }

    public get allBuffers(): Iterable<SyncedBuffer> {
        return this.values;
    }
}

class PendingDiagnostics extends ResourceMap<number> {
    public getOrderedFileSet(): ResourceMap<void> {
        const orderedResources = Array.from(this.entries)
            .sort((a, b) => a.value - b.value)
            .map(entry => entry.resource);

        const map = new ResourceMap<void>(this._normalizePath, this.config);
        for (const resource of orderedResources) {
            map.set(resource, undefined);
        }
        return map;
    }
}

class GetErrRequest {
    public static executeGetErrRequest(
        client: ITypeScriptServiceClient,
        files: ResourceMap<void>,
        onDone: () => void,
    ) {
        return new GetErrRequest(client, files, onDone);
    }

    private _done = false;
    private readonly _token: lsp.CancellationTokenSource = new lsp.CancellationTokenSource();

    private constructor(
        private readonly client: ITypeScriptServiceClient,
        public readonly files: ResourceMap<void>,
        onDone: () => void,
    ) {
        if (!this.isErrorReportingEnabled()) {
            this._done = true;
            setImmediate(onDone);
            return;
        }

        const supportsSyntaxGetErr = this.client.apiVersion.gte(API.v440);
        const allFiles = coalesce(Array.from(files.entries)
            .filter(entry => supportsSyntaxGetErr || client.hasCapabilityForResource(entry.resource, ClientCapability.Semantic))
            .map(entry => client.toTsFilePath(entry.resource)));

        if (!allFiles.length) {
            this._done = true;
            setImmediate(onDone);
        } else {
            const request = this.areProjectDiagnosticsEnabled()
                // Note that geterrForProject is almost certainly not the api we want here as it ends up computing far
                // too many diagnostics
                ? client.executeAsync(CommandTypes.GeterrForProject, { delay: 0, file: allFiles[0] }, this._token.token)
                : client.executeAsync(CommandTypes.Geterr, { delay: 0, files: allFiles }, this._token.token);

            request.finally(() => {
                if (this._done) {
                    return;
                }
                this._done = true;
                onDone();
            });
        }
    }

    private isErrorReportingEnabled() {
        if (this.client.apiVersion.gte(API.v440)) {
            return true;
        } else {
            // Older TS versions only support `getErr` on semantic server
            return this.client.capabilities.has(ClientCapability.Semantic);
        }
    }

    private areProjectDiagnosticsEnabled() {
        return this.client.configuration.enableProjectDiagnostics && this.client.capabilities.has(ClientCapability.Semantic);
    }

    public cancel(): any {
        if (!this._done) {
            this._token.cancel();
        }

        this._token.dispose();
    }
}

class TabResourceTracker extends Disposable {
    private readonly _onDidChange = this._register(new vscode.EventEmitter<{
        readonly closed: Iterable<Uri>;
        readonly opened: Iterable<Uri>;
    }>());
    public readonly onDidChange = this._onDidChange.event;

    private readonly _tabResources: ResourceMap<{ readonly tabs: Set<vscode.Tab>; }>;

    constructor(
        normalizePath: (resource: Uri) => string | undefined,
        config: {
            readonly onCaseInsensitiveFileSystem: boolean;
        },
    ) {
        super();

        this._tabResources = new ResourceMap<{ readonly tabs: Set<vscode.Tab>; }>(normalizePath, config);

        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                this.add(tab);
            }
        }

        this._register(vscode.window.tabGroups.onDidChangeTabs(e => {
            const closed = e.closed.flatMap(tab => this.delete(tab));
            const opened = e.opened.flatMap(tab => this.add(tab));
            if (closed.length || opened.length) {
                this._onDidChange.fire({ closed, opened });
            }
        }));
    }

    public has(resource: Uri): boolean {
        const entry = this._tabResources.get(resource);
        return !!entry && entry.tabs.size > 0;
    }

    private add(tab: vscode.Tab): Uri[] {
        const addedResources: Uri[] = [];
        for (const uri of this.getResourcesForTab(tab)) {
            const entry = this._tabResources.get(uri);
            if (entry) {
                entry.tabs.add(tab);
            } else {
                this._tabResources.set(uri, { tabs: new Set([tab]) });
                addedResources.push(uri);
            }
        }
        return addedResources;
    }

    private delete(tab: vscode.Tab): Uri[] {
        const closedResources: Uri[] = [];
        for (const uri of this.getResourcesForTab(tab)) {
            const entry = this._tabResources.get(uri);
            if (!entry) {
                continue;
            }

            entry.tabs.delete(tab);
            if (entry.tabs.size === 0) {
                this._tabResources.delete(uri);
                closedResources.push(uri);
            }
        }
        return closedResources;
    }

    private getResourcesForTab(tab: vscode.Tab): Uri[] {
        if (tab.input instanceof vscode.TabInputText) {
            return [tab.input.uri];
        } else if (tab.input instanceof vscode.TabInputTextDiff) {
            return [tab.input.original, tab.input.modified];
        } else if (tab.input instanceof vscode.TabInputNotebook) {
            return [tab.input.uri];
        } else {
            return [];
        }
    }
}

export default class BufferSyncSupport extends Disposable {
    private readonly client: ITypeScriptServiceClient;

    private _validateJavaScript = true;
    private _validateTypeScript = true;
    private readonly modeIds: Set<string>;
    private readonly syncedBuffers: SyncedBufferMap;
    private readonly pendingDiagnostics: PendingDiagnostics;
    private readonly diagnosticDelayer: Delayer<any>;
    private pendingGetErr: GetErrRequest | undefined;
    private listening = false;
    private readonly synchronizer: BufferSynchronizer;

    private readonly _tabResources: TabResourceTracker;

    constructor(
        client: ITypeScriptServiceClient,
        modeIds: readonly string[],
        onCaseInsensitiveFileSystem: boolean,
    ) {
        super();
        this.client = client;
        this.modeIds = new Set<string>(modeIds);

        this.diagnosticDelayer = new Delayer<any>(300);

        const pathNormalizer = (path: Uri) => this.client.toTsFilePath(path);
        this.syncedBuffers = new SyncedBufferMap(pathNormalizer, { onCaseInsensitiveFileSystem });
        this.pendingDiagnostics = new PendingDiagnostics(pathNormalizer, { onCaseInsensitiveFileSystem });
        this.synchronizer = new BufferSynchronizer(client, pathNormalizer, onCaseInsensitiveFileSystem);

        this._tabResources = this._register(new TabResourceTracker(pathNormalizer, { onCaseInsensitiveFileSystem }));
        this._register(this._tabResources.onDidChange(e => {
            if (this.client.configuration.enableProjectDiagnostics) {
                return;
            }

            for (const closed of e.closed) {
                const syncedBuffer = this.syncedBuffers.get(closed);
                if (syncedBuffer) {
                    this.pendingDiagnostics.delete(closed);
                    this.pendingGetErr?.files.delete(closed);
                }
            }

            for (const opened of e.opened) {
                const syncedBuffer = this.syncedBuffers.get(opened);
                if (syncedBuffer) {
                    this.requestDiagnostic(syncedBuffer);
                }
            }
        }));

        this.updateConfiguration();
        vscode.workspace.onDidChangeConfiguration(this.updateConfiguration, this, this._disposables);
    }

    private readonly _onDelete = this._register(new vscode.EventEmitter<Uri>());
    public readonly onDelete = this._onDelete.event;

    private readonly _onWillChange = this._register(new vscode.EventEmitter<Uri>());
    public readonly onWillChange = this._onWillChange.event;

    public listen(): void {
        if (this.listening) {
            return;
        }
        this.listening = true;
        vscode.workspace.onDidOpenTextDocument(this.openTextDocument, this, this._disposables);
        vscode.workspace.onDidCloseTextDocument(this.onDidCloseTextDocument, this, this._disposables);
        vscode.workspace.onDidChangeTextDocument(this.onDidChangeTextDocument, this, this._disposables);
        vscode.window.onDidChangeVisibleTextEditors(e => {
            for (const { document } of e) {
                const syncedBuffer = this.syncedBuffers.get(document.uri);
                if (syncedBuffer) {
                    this.requestDiagnostic(syncedBuffer);
                }
            }
        }, this, this._disposables);
        vscode.workspace.textDocuments.forEach(this.openTextDocument, this);
    }

    public handles(resource: Uri): boolean {
        return this.syncedBuffers.has(resource);
    }

    public ensureHasBuffer(resource: Uri): boolean {
        if (this.syncedBuffers.has(resource)) {
            return true;
        }

        const existingDocument = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === resource.toString());
        if (existingDocument) {
            return this.openTextDocument(existingDocument);
        }

        return false;
    }

    public toVsCodeResource(resource: Uri): Uri {
        const filepath = this.client.toTsFilePath(resource);
        for (const buffer of this.syncedBuffers.allBuffers) {
            if (buffer.filepath === filepath) {
                return buffer.resource;
            }
        }
        return resource;
    }

    public toResource(filePath: string): Uri {
        const buffer = this.syncedBuffers.getForPath(filePath);
        if (buffer) {
            return buffer.resource;
        }
        return Uri.file(filePath);
    }

    public reset(): void {
        this.pendingGetErr?.cancel();
        this.pendingDiagnostics.clear();
        this.synchronizer.reset();
    }

    public reinitialize(): void {
        this.reset();
        for (const buffer of this.syncedBuffers.allBuffers) {
            buffer.open();
        }
    }

    public openTextDocument(document: TextDocument): boolean {
        if (!this.modeIds.has(document.languageId)) {
            return false;
        }
        const resource = document.uri;
        const filepath = this.client.toTsFilePath(resource);
        if (!filepath) {
            return false;
        }

        if (this.syncedBuffers.has(resource)) {
            return true;
        }

        const syncedBuffer = new SyncedBuffer(document, filepath, this.client, this.synchronizer);
        this.syncedBuffers.set(resource, syncedBuffer);
        syncedBuffer.open();
        this.requestDiagnostic(syncedBuffer);
        return true;
    }

    public closeResource(resource: Uri): void {
        const syncedBuffer = this.syncedBuffers.get(resource);
        if (!syncedBuffer) {
            return;
        }

        this.pendingDiagnostics.delete(resource);
        this.pendingGetErr?.files.delete(resource);
        this.syncedBuffers.delete(resource);
        const wasBufferOpen = syncedBuffer.close();
        this._onDelete.fire(resource);
        if (wasBufferOpen) {
            this.requestAllDiagnostics();
        }
    }

    public interruptGetErr<R>(f: () => R): R {
        if (!this.pendingGetErr
            || this.client.configuration.enableProjectDiagnostics // `geterr` happens on separate server so no need to cancel it.
        ) {
            return f();
        }

        this.pendingGetErr.cancel();
        this.pendingGetErr = undefined;
        const result = f();
        this.triggerDiagnostics();
        return result;
    }

    public beforeCommand(command: string): void {
        this.synchronizer.beforeCommand(command);
    }

    private onDidCloseTextDocument(document: TextDocument): void {
        this.closeResource(document.uri);
    }

    private onDidChangeTextDocument(e: lsp.TextDocumentContentChangeEvent): void {
        const syncedBuffer = this.syncedBuffers.get(e.document.uri);
        if (!syncedBuffer) {
            return;
        }

        this._onWillChange.fire(syncedBuffer.resource);

        syncedBuffer.onContentChanged(e.contentChanges);
        const didTrigger = this.requestDiagnostic(syncedBuffer);

        if (!didTrigger && this.pendingGetErr) {
            // In this case we always want to re-trigger all diagnostics
            this.pendingGetErr.cancel();
            this.pendingGetErr = undefined;
            this.triggerDiagnostics();
        }
    }

    public requestAllDiagnostics(): void {
        for (const buffer of this.syncedBuffers.allBuffers) {
            if (this.shouldValidate(buffer)) {
                this.pendingDiagnostics.set(buffer.resource, Date.now());
            }
        }
        this.triggerDiagnostics();
    }

    public getErr(resources: readonly Uri[]): any {
        const handledResources = resources.filter(resource => this.handles(resource));
        if (!handledResources.length) {
            return;
        }

        for (const resource of handledResources) {
            this.pendingDiagnostics.set(resource, Date.now());
        }

        this.triggerDiagnostics();
    }

    private triggerDiagnostics(delay = 200) {
        this.diagnosticDelayer.trigger(() => {
            this.sendPendingDiagnostics();
        }, delay);
    }

    private requestDiagnostic(buffer: SyncedBuffer): boolean {
        if (!this.shouldValidate(buffer)) {
            return false;
        }

        this.pendingDiagnostics.set(buffer.resource, Date.now());

        const delay = Math.min(Math.max(Math.ceil(buffer.lineCount / 20), 300), 800);
        this.triggerDiagnostics(delay);
        return true;
    }

    public hasPendingDiagnostics(resource: Uri): boolean {
        return this.pendingDiagnostics.has(resource);
    }

    private sendPendingDiagnostics(): void {
        const orderedFileSet = this.pendingDiagnostics.getOrderedFileSet();

        if (this.pendingGetErr) {
            this.pendingGetErr.cancel();

            for (const { resource } of this.pendingGetErr.files.entries) {
                if (this.syncedBuffers.get(resource)) {
                    orderedFileSet.set(resource, undefined);
                }
            }

            this.pendingGetErr = undefined;
        }

        // Add all open TS buffers to the geterr request. They might be visible
        for (const buffer of this.syncedBuffers.values) {
            orderedFileSet.set(buffer.resource, undefined);
        }

        if (orderedFileSet.size) {
            const getErr = this.pendingGetErr = GetErrRequest.executeGetErrRequest(this.client, orderedFileSet, () => {
                if (this.pendingGetErr === getErr) {
                    this.pendingGetErr = undefined;
                }
            });
        }

        this.pendingDiagnostics.clear();
    }

    private updateConfiguration() {
        const jsConfig = vscode.workspace.getConfiguration('javascript', null);
        const tsConfig = vscode.workspace.getConfiguration('typescript', null);

        this._validateJavaScript = jsConfig.get<boolean>('validate.enable', true);
        this._validateTypeScript = tsConfig.get<boolean>('validate.enable', true);
    }

    private shouldValidate(buffer: SyncedBuffer): boolean {
        if (!this.client.configuration.enableProjectDiagnostics && !this._tabResources.has(buffer.resource)) { // Only validate resources that are showing to the user
            return false;
        }

        switch (buffer.kind) {
            case BufferKind.JavaScript:
                return this._validateJavaScript;

            case BufferKind.TypeScript:
            default:
                return this._validateTypeScript;
        }
    }
}
