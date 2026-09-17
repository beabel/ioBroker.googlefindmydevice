// Augments the ioBroker adapter config type with this adapter's own
// native.* fields (declared in io-package.json), so `this.config.*` is
// typed correctly for `npm run check` (tsc --checkJs).

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            oauthToken: string;
            email: string;
            androidId: string;
            securityToken: string;
            aasToken: string;
            sharedKeyJson: string;
            ownerKey: string;
            ownerKeyVersion: number;
            pollInterval: number;
            deviceSettings: {
                canonicId: string;
                name: string;
                locate: boolean;
                intervalMinutes: number;
            }[];
        }
    }
}

export {};
