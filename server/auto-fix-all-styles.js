import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '../client/src');

function getAllFiles(dir, ext) {
  let files = [];
  fs.readdirSync(dir).forEach(file => {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      files = files.concat(getAllFiles(fullPath, ext));
    } else if (file.endsWith(ext)) {
      files.push(fullPath);
    }
  });
  return files;
}

const jsxFiles = getAllFiles(srcDir, '.jsx');

jsxFiles.forEach(filePath => {
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;

  // Regex patterns to remove nested element tag objects inside styles definition
  // e.g., h2: { ... }, h3: { ... }, h5: { ... }, h6: { ... } inside objects
  const nestedTagRegex = /,\s*(?:h[1-6]|p|div|span|button|a)\s*:\s*\{[\s\S]*?\}/g;
  
  if (nestedTagRegex.test(content)) {
    content = content.replace(nestedTagRegex, '');
    modified = true;
  }

  // Also match without leading comma
  const nestedTagRegex2 = /(?:h[1-6]|p|div|span|button|a)\s*:\s*\{[\s\S]*?\},\s*/g;
  if (nestedTagRegex2.test(content)) {
    content = content.replace(nestedTagRegex2, '');
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Cleaned up nested style objects in ${path.relative(srcDir, filePath)}`);
  }
});

console.log('All JSX style files auto-fixed successfully!');
