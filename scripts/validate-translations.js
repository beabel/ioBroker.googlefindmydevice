'use strict';

// Checks admin/jsonConfig.json against its translation files:
//  - every text the jsonConfig references exists in all 11 languages,
//  - no translation file carries keys the jsonConfig doesn't use,
//  - keys are sorted alphabetically,
//  - no value is left as an untranslated copy of the English text.
// Runs as the `pretest` step.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
const I18N_PROPERTIES = new Set([
    'text',
    'label',
    'help',
    'title',
    'tooltip',
    'placeholder',
    'noDataText',
    'ok',
    'cancel',
]);
// Language-neutral texts that are legitimately identical in every language.
const SAME_IN_ALL_LANGUAGES = new Set(['device_id_col']);

/**
 * Collects every translation key the jsonConfig references.
 *
 * @param {unknown} node the (sub-)tree of the parsed jsonConfig
 * @param {Set<string>} keys collects the referenced keys
 */
function collectKeys(node, keys) {
    if (Array.isArray(node)) {
        node.forEach(child => collectKeys(child, keys));
    } else if (node && typeof node === 'object') {
        for (const [name, value] of Object.entries(node)) {
            if (I18N_PROPERTIES.has(name) && typeof value === 'string') {
                keys.add(value);
            } else {
                collectKeys(value, keys);
            }
        }
    }
}

/**
 * Reads one language's translation file.
 *
 * @param {string} lang language code
 * @returns {Record<string, string>} the parsed translations
 */
function readLanguage(lang) {
    const file = path.join(ROOT, 'admin', 'i18n', `${lang}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const problems = [];
const used = new Set();
collectKeys(JSON.parse(fs.readFileSync(path.join(ROOT, 'admin', 'jsonConfig.json'), 'utf8')), used);

let english = {};
for (const lang of LANGUAGES) {
    let translations;
    try {
        translations = readLanguage(lang);
    } catch (err) {
        problems.push(`${lang}: cannot read admin/i18n/${lang}.json (${err.message})`);
        continue;
    }
    if (lang === 'en') {
        english = translations;
    }

    const keys = Object.keys(translations);
    for (const key of used) {
        if (!(key in translations)) {
            problems.push(`${lang}: missing key "${key}"`);
        }
    }
    for (const key of keys) {
        if (!used.has(key)) {
            problems.push(`${lang}: orphaned key "${key}" (not used by jsonConfig.json)`);
        }
        if (typeof translations[key] !== 'string' || translations[key].trim() === '') {
            problems.push(`${lang}: empty value for "${key}"`);
        }
        if (lang !== 'en' && translations[key] === english[key] && !SAME_IN_ALL_LANGUAGES.has(key)) {
            problems.push(`${lang}: "${key}" is still the English text`);
        }
    }
    if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) {
        problems.push(`${lang}: keys are not sorted alphabetically`);
    }
}

if (problems.length > 0) {
    console.error(`Translation check failed (${problems.length} problem(s)):`);
    problems.forEach(problem => console.error(` - ${problem}`));
    process.exit(1);
}
console.log(`Translations OK: ${used.size} keys in ${LANGUAGES.length} languages.`);
