import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const packagePath = path.join(rootDir, 'package.json');
const manifestPath = path.join(rootDir, 'manifest.json');
const checkOnly = process.argv.includes('--check');

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const packageJson = readJson(packagePath);
const manifestJson = readJson(manifestPath);

if (manifestJson.version === packageJson.version) {
  process.exit(0);
}

if (checkOnly) {
  console.error(`Version mismatch: package.json=${packageJson.version}, manifest.json=${manifestJson.version}`);
  process.exit(1);
}

manifestJson.version = packageJson.version;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifestJson, null, 2)}\n`);
