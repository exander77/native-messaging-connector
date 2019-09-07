import {ChildProcessWithoutNullStreams} from 'child_process';
import {NativeAppType} from "./NativeConnector";
import * as os from "os";
import {Writable} from "stream";

function streamWrite(
    stream: Writable,
    chunk: string | Buffer | Uint8Array,
    encoding = 'utf8'): Promise<void> {
    return new Promise((resolve, reject) => {
        const errListener = (err: Error) => {
            stream.removeListener('error', errListener);
            reject(err);
        };
        stream.addListener('error', errListener);
        const callback = () => {
            stream.removeListener('error', errListener);
            resolve(undefined);
        };
        stream.write(chunk, encoding, callback);
    });
}

function readUint32(buffer: Buffer, offset: number): number {
    switch (os.endianness()) {
        case "BE":
            return buffer.readUInt32BE(offset);
        case "LE":
            return buffer.readUInt32LE(offset);
    }
}

function writeUint32(buffer: Buffer, value: number, offset: number) {
    switch (os.endianness()) {
        case "BE":
            buffer.writeUInt32BE(value, offset);
            break;
        case "LE":
            buffer.writeUInt32LE(value, offset);
            break;
    }
}

export class NativeConnection {
    private _process: ChildProcessWithoutNullStreams;
    private _app_type: NativeAppType;
    private _connected: boolean;
    private readonly _messageQueue: Array<Buffer>;
    private readonly _readQueue: Array<(msg: any) => void>;
    private _incompleteMessage: string;
    private _remainingMessageSize: number;

    public constructor(process: ChildProcessWithoutNullStreams, app_type: NativeAppType) {
        this._process = process;
        this._app_type = app_type;
        this._connected = true;
        this._messageQueue = [];
        this._readQueue = [];
        this._remainingMessageSize = 0;

        this._process.on("error", () => this._connected = false);
        this._process.on("close", () => this._connected = false);
        this._process.on("exit", () => this._connected = false);

        this._process.stdout.on("data", (chunk: Buffer) => {
            this._messageQueue.push(chunk);
            this.processMessageQueue();
        });
    }

    private dispatchMessage(data: string) {
        const callback = this._readQueue.shift();

        callback(JSON.parse(data));
    }

    private processMessageQueue(): void {
        if (this._readQueue.length == 0) {
            // No readers are registered so just let the data in the queue so that we don't loose messages.
            return;
        }

        if (this._messageQueue.length == 0) {
            // Nothing in the queue, nothing to do
            return;
        }

        while (this._messageQueue.length > 0 && this._readQueue.length) {
            // We are expecting the start of a message here
            const buffer = this._messageQueue[0];

            if (this._remainingMessageSize > 0) {
                // We have an incomplete message in our buffer so we need to finish that first.
                if (buffer.length >= this._remainingMessageSize) {
                    // Remaining message fits entirely into the current buffer
                    this._incompleteMessage += buffer.toString("utf-8", 0, this._remainingMessageSize);
                    this.dispatchMessage(this._incompleteMessage);

                    if (buffer.length > this._remainingMessageSize) {
                        // There is more data in this buffer
                        this._messageQueue[0] = buffer.slice(this._remainingMessageSize);
                    } else {
                        // Buffer has been entirely consumed
                        this._messageQueue.shift();
                    }

                    // Reset state machine variables
                    this._remainingMessageSize = 0;
                    this._incompleteMessage = null;
                } else {
                    // buffer did not contain enough data. Add data to our buffer and continue
                    this._incompleteMessage += buffer.toString("utf-8");
                    this._remainingMessageSize -= buffer.length;
                    this._messageQueue.shift();
                }
            } else {
                const messageLen = readUint32(buffer, 0);

                if (messageLen + 4 >= buffer.length) {
                    // Message fits entirely into the buffer
                    const messageStr = buffer.toString("utf-8", 4, 4 + messageLen);
                    this.dispatchMessage(messageStr);

                    if (messageLen + 4 > buffer.length) {
                        // There are more messages left in the buffer
                        this._messageQueue[0] = buffer.slice(messageLen + 4);
                    } else {
                        // Buffer contained the entire message
                        this._messageQueue.shift();
                    }
                } else {
                    // Buffer did not contain the entire message
                    this._incompleteMessage = buffer.toString("utf-8", 4);
                    this._remainingMessageSize = messageLen - (buffer.length - 4);

                    // Current message has been completely processed
                    this._messageQueue.shift();
                }
            }
        }
    }

    public async sendMessage(message: any) {
        const jsonContent = JSON.stringify(message, null, 0);
        const messageLen = jsonContent.length;

        const messageBuffer = Buffer.alloc(messageLen + 4);
        writeUint32(messageBuffer, messageLen, 0);
        messageBuffer.write(jsonContent, 4, "utf-8");

        await streamWrite(this._process.stdin, messageBuffer);
    }

    public readMessage<T = any>(timeoutMs?: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            if (timeoutMs) {
                const timeoutId = setTimeout(() => {
                    const index = this._readQueue.indexOf(resolve);
                    if (index >= 0) {
                        this._readQueue.splice(index, 1);
                    }

                    reject("Timeout reached");
                }, timeoutMs);

                this._readQueue.push(x => {
                    clearTimeout(timeoutId);
                    resolve(x);
                });
            } else {
                this._readQueue.push(resolve);
            }

            // Try processing the queue immediately since messages may have been queued
            this.processMessageQueue();
        })
    }

    public disconnect() {
        if (this._connected) {
            this._process.kill();
            this._connected = false;
        }
    }
}
