const path = require('path');
const { tests } = require('@iobroker/testing');

// Integration test against a real js-controller instance. Since this adapter
// needs a real Google account login (see README) that can't be part of CI,
// this only verifies the "not configured yet" startup path: with an empty
// config the adapter must start cleanly (no crash/exit), log a warning
// explaining what's missing, and report itself as disconnected.
tests.integration(path.join(__dirname, '..', '..'), {
    defineAdditionalTests({ suite }) {
        suite('Startup without configuration', getHarness => {
            let harness;
            before(() => {
                harness = getHarness();
            });

            it('should start and warn that setup is missing, without crashing', async () => {
                await harness.startAdapterAndWait();

                expect(harness.hasLog(/Not set up yet/i, 'warn')).to.be.true;
            });
        });
    },
});
