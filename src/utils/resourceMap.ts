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
import * as fileSchemes from './fileSchemes.js';

/**
 * Maps of file resources
 *
 * Attempts to handle correct mapping on both case sensitive and case in-sensitive
 * file systems.
 */
export class ResourceMap<T> {
    private static readonly defaultPathNormalizer = (resource: Uri): string => {
        if (resource.scheme === fileSchemes.file) {
            return resource.fsPath;
        }
        return resource.toString(true);
    };

    private readonly _map = new Map<string, { readonly resource: Uri; value: T; }>();

    constructor(
        protected readonly _normalizePath: (resource: Uri) => string | undefined = ResourceMap.defaultPathNormalizer,
        protected readonly config: {
            readonly onCaseInsensitiveFileSystem: boolean;
        },
    ) { }

    public get size(): number {
        return this._map.size;
    }

    public has(resource: Uri): boolean {
        const file = this.toKey(resource);
        return !!file && this._map.has(file);
    }

    public get(resource: Uri): T | undefined {
        const file = this.toKey(resource);
        if (!file) {
            return undefined;
        }
        const entry = this._map.get(file);
        return entry ? entry.value : undefined;
    }

    public set(resource: Uri, value: T): void {
        const file = this.toKey(resource);
        if (!file) {
            return;
        }
        const entry = this._map.get(file);
        if (entry) {
            entry.value = value;
        } else {
            this._map.set(file, { resource, value });
        }
    }

    public delete(resource: Uri): void {
        const file = this.toKey(resource);
        if (file) {
            this._map.delete(file);
        }
    }

    public clear(): void {
        this._map.clear();
    }

    public get values(): Iterable<T> {
        return Array.from(this._map.values(), x => x.value);
    }

    public get entries(): Iterable<{ resource: Uri; value: T; }> {
        return this._map.values();
    }

    private toKey(resource: Uri): string | undefined {
        const key = this._normalizePath(resource);
        if (!key) {
            return key;
        }
        return this.isCaseInsensitivePath(key) ? key.toLowerCase() : key;
    }

    private isCaseInsensitivePath(path: string) {
        if (isWindowsPath(path)) {
            return true;
        }
        return path[0] === '/' && this.config.onCaseInsensitiveFileSystem;
    }
}

function isWindowsPath(path: string): boolean {
    return /^[a-zA-Z]:[/\\]/.test(path);
}
