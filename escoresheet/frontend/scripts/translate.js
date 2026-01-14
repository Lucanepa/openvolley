/**
 * Translation script using DeepL API
 * Translates en.json to other locale files (de, de-CH, fr, it)
 *
 * Usage:
 *   node scripts/translate.js           # Translate all languages
 *   node scripts/translate.js de        # Translate only German
 *   node scripts/translate.js fr it     # Translate French and Italian
 *   node scripts/translate.js --dry-run # Preview without saving
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEEPL_API_KEY = process.env.DEEPL_KEY;
const DEEPL_API_URL = 'https://api-free.deepl.com/v2/translate';

const LOCALES_DIR = path.join(__dirname, '../src/i18n/locales');

// Map our locale codes to DeepL target language codes
const LANGUAGE_MAP = {
  'de': 'DE',
  'fr': 'FR',
  'it': 'IT'
};

// Special locales that inherit from another locale (no DeepL translation)
// de-CH (Swiss German/Züritüütsch) inherits from de.json for missing keys
// These require manual translation for proper dialect
const INHERIT_FROM = {
  'de-CH': 'de'
};

// Keys that should NOT be translated (e.g., technical values, abbreviations)
const SKIP_KEYS = [
  'L1', 'L2', 'na', 'tbc', 'vs', 'ok', 'OK'
];

// Patterns to preserve (placeholders like {{count}}, {{team}}, etc.)
const PLACEHOLDER_REGEX = /\{\{[^}]+\}\}/g;

async function translateText(texts, targetLang) {
  if (!DEEPL_API_KEY) {
    throw new Error('DEEPL_KEY not found in .env file');
  }

  const response = await fetch(DEEPL_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: texts,
      target_lang: targetLang,
      source_lang: 'EN',
      preserve_formatting: true,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`DeepL API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.translations.map(t => t.text);
}

function flattenObject(obj, prefix = '') {
  const result = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, newKey));
    } else {
      result[newKey] = value;
    }
  }

  return result;
}

function unflattenObject(obj) {
  const result = {};

  for (const [key, value] of Object.entries(obj)) {
    const keys = key.split('.');
    let current = result;

    for (let i = 0; i < keys.length - 1; i++) {
      if (!(keys[i] in current)) {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }

    current[keys[keys.length - 1]] = value;
  }

  return result;
}

function shouldSkipTranslation(key, value) {
  // Skip non-string values
  if (typeof value !== 'string') return true;

  // Skip empty strings
  if (!value.trim()) return true;

  // Skip if it's in the skip list
  const lastKey = key.split('.').pop();
  if (SKIP_KEYS.includes(lastKey) || SKIP_KEYS.includes(value)) return true;

  // Skip if it's just numbers or special characters
  if (/^[\d\s\-_.:\/\\]+$/.test(value)) return true;

  return false;
}

function protectPlaceholders(text) {
  const placeholders = [];
  const protectedText = text.replace(PLACEHOLDER_REGEX, (match) => {
    placeholders.push(match);
    return `__PLACEHOLDER_${placeholders.length - 1}__`;
  });
  return { protectedText, placeholders };
}

function restorePlaceholders(text, placeholders) {
  let result = text;
  placeholders.forEach((placeholder, index) => {
    result = result.replace(`__PLACEHOLDER_${index}__`, placeholder);
  });
  return result;
}

async function translateLocale(targetLocale, sourceData, dryRun = false) {
  const targetLang = LANGUAGE_MAP[targetLocale];
  if (!targetLang) {
    console.error(`Unknown locale: ${targetLocale}`);
    return;
  }

  console.log(`\n📝 Translating to ${targetLocale} (${targetLang})...`);

  const flatSource = flattenObject(sourceData);
  const targetPath = path.join(LOCALES_DIR, `${targetLocale}.json`);

  // Load existing translations if available
  let existingTranslations = {};
  if (fs.existsSync(targetPath)) {
    try {
      existingTranslations = flattenObject(JSON.parse(fs.readFileSync(targetPath, 'utf-8')));
      console.log(`   Found existing ${targetLocale}.json with ${Object.keys(existingTranslations).length} keys`);
    } catch (e) {
      console.log(`   Warning: Could not parse existing ${targetLocale}.json, starting fresh`);
    }
  }

  // Find keys that need translation (new or changed in source)
  const keysToTranslate = [];
  const textsToTranslate = [];
  const placeholdersMap = {};

  for (const [key, value] of Object.entries(flatSource)) {
    if (shouldSkipTranslation(key, value)) {
      continue;
    }

    // Check if translation already exists and source hasn't changed
    // We can't detect source changes easily, so we'll translate missing keys only
    if (existingTranslations[key] && existingTranslations[key] !== value) {
      continue; // Keep existing translation
    }

    if (!existingTranslations[key]) {
      const { protectedText, placeholders } = protectPlaceholders(value);
      keysToTranslate.push(key);
      textsToTranslate.push(protectedText);
      placeholdersMap[key] = placeholders;
    }
  }

  console.log(`   Keys to translate: ${keysToTranslate.length}`);

  if (keysToTranslate.length === 0) {
    console.log(`   ✅ ${targetLocale} is up to date!`);
    return;
  }

  if (dryRun) {
    console.log(`   [DRY RUN] Would translate ${keysToTranslate.length} keys`);
    console.log(`   Sample keys: ${keysToTranslate.slice(0, 5).join(', ')}${keysToTranslate.length > 5 ? '...' : ''}`);
    return;
  }

  // Translate in batches (DeepL has limits)
  const BATCH_SIZE = 50;
  const translatedTexts = [];

  for (let i = 0; i < textsToTranslate.length; i += BATCH_SIZE) {
    const batch = textsToTranslate.slice(i, i + BATCH_SIZE);
    console.log(`   Translating batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(textsToTranslate.length / BATCH_SIZE)}...`);

    try {
      const translated = await translateText(batch, targetLang);
      translatedTexts.push(...translated);

      // Small delay between batches to respect rate limits
      if (i + BATCH_SIZE < textsToTranslate.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`   ❌ Error translating batch: ${error.message}`);
      throw error;
    }
  }

  // Build the result object
  const result = { ...flatSource };

  // Apply existing translations
  for (const [key, value] of Object.entries(existingTranslations)) {
    if (key in result) {
      result[key] = value;
    }
  }

  // Apply new translations
  for (let i = 0; i < keysToTranslate.length; i++) {
    const key = keysToTranslate[i];
    const translated = restorePlaceholders(translatedTexts[i], placeholdersMap[key]);
    result[key] = translated;
  }

  // Unflatten and save
  const finalResult = unflattenObject(result);
  fs.writeFileSync(targetPath, JSON.stringify(finalResult, null, 2) + '\n', 'utf-8');

  console.log(`   ✅ Saved ${targetLocale}.json with ${Object.keys(result).length} keys`);
}

async function syncInheritedLocale(targetLocale, sourceData, dryRun = false) {
  const parentLocale = INHERIT_FROM[targetLocale];
  console.log(`\n🇨🇭 Syncing ${targetLocale} (inherits from ${parentLocale})...`);
  console.log(`   ⚠️  Swiss German requires manual translation - only adding structure`);

  const flatSource = flattenObject(sourceData);
  const targetPath = path.join(LOCALES_DIR, `${targetLocale}.json`);
  const parentPath = path.join(LOCALES_DIR, `${parentLocale}.json`);

  // Load parent locale (de.json) for fallback values
  let parentTranslations = {};
  if (fs.existsSync(parentPath)) {
    try {
      parentTranslations = flattenObject(JSON.parse(fs.readFileSync(parentPath, 'utf-8')));
    } catch (e) {
      console.log(`   Warning: Could not parse ${parentLocale}.json`);
    }
  }

  // Load existing translations
  let existingTranslations = {};
  if (fs.existsSync(targetPath)) {
    try {
      existingTranslations = flattenObject(JSON.parse(fs.readFileSync(targetPath, 'utf-8')));
      console.log(`   Found existing ${targetLocale}.json with ${Object.keys(existingTranslations).length} keys`);
    } catch (e) {
      console.log(`   Warning: Could not parse existing ${targetLocale}.json, starting fresh`);
    }
  }

  // Find missing keys
  const missingKeys = [];
  for (const key of Object.keys(flatSource)) {
    if (!existingTranslations[key]) {
      missingKeys.push(key);
    }
  }

  console.log(`   Missing keys: ${missingKeys.length}`);

  if (missingKeys.length === 0) {
    console.log(`   ✅ ${targetLocale} is up to date!`);
    return;
  }

  if (dryRun) {
    console.log(`   [DRY RUN] Would add ${missingKeys.length} keys from ${parentLocale}.json`);
    console.log(`   Sample keys: ${missingKeys.slice(0, 5).join(', ')}${missingKeys.length > 5 ? '...' : ''}`);
    return;
  }

  // Build result - start with source structure, apply existing, then fill missing from parent
  const result = { ...flatSource };

  // Apply existing translations (preserve Swiss German)
  for (const [key, value] of Object.entries(existingTranslations)) {
    if (key in result) {
      result[key] = value;
    }
  }

  // Fill missing keys from parent (standard German as placeholder)
  let filledFromParent = 0;
  for (const key of missingKeys) {
    if (parentTranslations[key]) {
      result[key] = parentTranslations[key];
      filledFromParent++;
    }
  }

  // Unflatten and save
  const finalResult = unflattenObject(result);
  fs.writeFileSync(targetPath, JSON.stringify(finalResult, null, 2) + '\n', 'utf-8');

  console.log(`   ✅ Added ${filledFromParent} keys from ${parentLocale}.json (needs manual Swiss German translation)`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const targetLocales = args.filter(arg => !arg.startsWith('--'));

  // Load source file
  const sourcePath = path.join(LOCALES_DIR, 'en.json');
  if (!fs.existsSync(sourcePath)) {
    console.error('❌ Source file en.json not found!');
    process.exit(1);
  }

  const sourceData = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
  console.log(`📖 Loaded en.json with ${Object.keys(flattenObject(sourceData)).length} keys`);

  // All available locales
  const allLocales = [...Object.keys(LANGUAGE_MAP), ...Object.keys(INHERIT_FROM)];

  // Determine which locales to process
  const localesToProcess = targetLocales.length > 0
    ? targetLocales.filter(l => allLocales.includes(l))
    : allLocales;

  if (localesToProcess.length === 0) {
    console.error('❌ No valid target locales specified');
    console.log('   Available locales:', allLocales.join(', '));
    process.exit(1);
  }

  console.log(`🎯 Target locales: ${localesToProcess.join(', ')}`);
  if (dryRun) {
    console.log('🔍 DRY RUN MODE - no files will be modified');
  }

  // Process DeepL-translated locales first (so inherited locales can use them)
  for (const locale of localesToProcess) {
    if (locale in LANGUAGE_MAP) {
      await translateLocale(locale, sourceData, dryRun);
    }
  }

  // Then process inherited locales
  for (const locale of localesToProcess) {
    if (locale in INHERIT_FROM) {
      await syncInheritedLocale(locale, sourceData, dryRun);
    }
  }

  console.log('\n✨ Translation complete!');
}

main().catch(error => {
  console.error('❌ Fatal error:', error.message);
  process.exit(1);
});
