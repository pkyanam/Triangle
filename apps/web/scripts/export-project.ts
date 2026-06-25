import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetDir = path.resolve(__dirname, '../public/project');

async function main(): Promise<void> {
  const source = process.argv[2];
  if (!source) {
    console.error('Usage: node export-project.ts <project-dir>');
    process.exit(1);
  }
  const sourceDir = path.resolve(source);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true });
  console.log(`Exported project from ${sourceDir} to ${targetDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
