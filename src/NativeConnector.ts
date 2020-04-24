import * as os from 'os';
import * as path from 'path';
import * as child_process from 'child_process';
import {promises as fsp} from 'fs';
import {NativeConnection} from "./NativeConnection";

export enum ManifestSearchLocation {
    Firefox = 1 << 0,
    Chrome = 1 << 1,
    Chromium = 1 << 2,
    Vivaldi = 1 << 3,
    All = 64 - 1,
}

export enum NativeAppType {
    Firefox,
    Chrome,
    Chromium,
    Vivaldi
}

function* getManifestLocations(search_location: ManifestSearchLocation): Generator<[string, NativeAppType]> {
    if (os.platform() == "linux") {
        if (search_location & ManifestSearchLocation.Firefox) {
            yield ["/usr/lib/mozilla/native-messaging-hosts/", NativeAppType.Firefox];
            yield [path.join(process.env.HOME, ".mozilla/native-messaging-hosts/"), NativeAppType.Firefox];
        }
        if (search_location & ManifestSearchLocation.Chrome) {
            yield ["/etc/opt/chrome/native-messaging-hosts", NativeAppType.Chrome];
        }
        if (search_location & ManifestSearchLocation.Chromium) {
            yield ["/etc/chromium/native-messaging-hosts", NativeAppType.Chromium];
        }
        if (search_location & ManifestSearchLocation.Vivaldi) {
            yield [path.join(process.env.HOME, ".config/vivaldi/NativeMessagingHosts"), NativeAppType.Vivaldi];
        }
    }
}

async function findManifest(manifest_name: string,
                            search_location: ManifestSearchLocation): Promise<[string, NativeAppType]> {
    for (const [searchPath, searchLocation] of getManifestLocations(search_location)) {
        const test_path = path.join(searchPath, manifest_name + ".json");

        try {
            const stats = await fsp.lstat(test_path);

            if (!stats.isFile()) {
                continue;
            }

            return [test_path, searchLocation];
        } catch (Error) {
            // Path does not exist
        }
    }

    return null;
}

interface NativeManifest {
    name: string;
    description: string;
    path: string;
    type: "stdio";
    allowed_extensions: Array<string>;
}

export class NativeConnector {
    private readonly _manifest: NativeManifest;
    private readonly _app_type: NativeAppType;

    private constructor(manifest: NativeManifest, app_type: NativeAppType) {
        this._manifest = manifest;
        this._app_type = app_type;
    }

    public connect() {
        const process = child_process.spawn(this._manifest.path);

        return new NativeConnection(process, this._app_type);
    }

    public static async create(manifest_name: string,
                               search_location: ManifestSearchLocation = ManifestSearchLocation.All): Promise<NativeConnector> {
        const [manifest_path, app_type] = await findManifest(manifest_name, search_location);

        if (manifest_path === null) {
            throw new Error("Manifest could not be found!");
        }

        const manifest_content = await fsp.readFile(manifest_path, {encoding: "utf-8"});

        if (manifest_content === null) {
            throw new Error("Manifest could not be read.");
        }

        try {
            const manifest = JSON.parse(manifest_content);

            return new NativeConnector(manifest, app_type);
        } catch (e) {
            throw new Error("Manifest content was no valid JSON: " + e);
        }
    }
}
