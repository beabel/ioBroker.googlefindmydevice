const path = require('path');
const { tests } = require('@iobroker/testing');

// Checks that package.json and io-package.json are consistent, and validates
// io-package.json / admin/jsonConfig.json against their official schemas.
tests.packageFiles(path.join(__dirname, '..', '..'));
