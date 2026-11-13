/* Vendored official @opencode/client 2.0.26.
Source: https://github.com/anomalyco/opencode/blob/v2.0.26/packages/client/src/promise/generated/client-error.ts
Source SHA256: 1c02bcfc01072693c43e71cc53c8dcca5d8d75327e09099cac9b37a0317ace2d
Generated using node:module.stripTypeScriptTypes (transform); no manual logic changes.
Only the ClientError import path is redirected to the adjacent reviewed file.

MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
export class ClientError extends Error {
    reason;
    name = "ClientError";
    constructor(reason, options){
        const detail = options?.detail ?? (options?.cause instanceof Error ? options.cause.message : undefined);
        super(detail ? `${reason}: ${detail}` : reason, options), this.reason = reason;
    }
}
