import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const packagePath = path.join(rootDir, 'package.json');
const manifestPath = path.join(rootDir, 'manifest.json');
const bumpType = process.argv[2] || 'patch';

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const writeJson = (filePath, value) => {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const packageJson = readJson(packagePath);
const manifestJson = readJson(manifestPath);
const versionParts = String(packageJson.version || '0.0.0').split('.').map((part) => Number.parseInt(part, 10));

if (versionParts.length !== 3 || versionParts.some((part) => Number.isNaN(part))) {
  throw new Error(`Unsupported semver version: ${packageJson.version}`);
}

const [major, minor, patch] = versionParts;
const nextVersion = bumpType === 'minor'
  ? `${major}.${minor + 1}.0`
  : bumpType === 'major'
    ? `${major + 1}.0.0`
    : `${major}.${minor}.${patch + 1}`;

packageJson.version = nextVersion;
manifestJson.version = nextVersion;

writeJson(packagePath, packageJson);
writeJson(manifestPath, manifestJson);

console.log(`ClickCap version bumped to ${nextVersion}`);
