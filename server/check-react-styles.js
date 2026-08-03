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
console.log(`Scanning ${jsxFiles.length} JSX files for invalid style props or syntax issues...`);

let issuesFound = 0;

jsxFiles.forEach(filePath => {
  const content = fs.readFileSync(filePath, 'utf8');
  const relPath = path.relative(srcDir, filePath);

  // Check for nested objects inside style objects definition e.g. const styles = { foo: { bar: { ... } } }
  const stylesMatch = content.match(/const\s+styles\s*=\s*(\{[\s\S]*?\});/);
  if (stylesMatch) {
    const stylesCode = stylesMatch[1];
    try {
      // Evaluate styles object
      const evalStyles = new Function(`return ${stylesCode}`)();
      for (const [key, val] of Object.entries(evalStyles)) {
        if (typeof val === 'object' && val !== null) {
          for (const [subKey, subVal] of Object.entries(val)) {
            if (typeof subVal === 'object' && subVal !== null) {
              console.error(`[ERROR] File ${relPath}: styles.${key}.${subKey} is a nested object! Inline React styles do not support nested objects.`);
              issuesFound++;
            }
          }
        }
      }
    } catch (e) {
      console.warn(`Could not evaluate styles object in ${relPath}: ${e.message}`);
    }
  }

  // Check for inline style={{ ... }} where an object property is a nested object
  const inlineStyleMatches = [...content.matchAll(/style\s*=\s*\{\s*\{([\s\S]*?)\}\s*\}/g)];
  inlineStyleMatches.forEach(m => {
    const code = m[1];
    if (code.includes('{') && !code.includes('?')) {
      // Potential nested object inside style={{ ... }}
      console.warn(`[WARN] File ${relPath}: check inline style for nested object: ${code.slice(0, 50)}...`);
    }
  });
});

if (issuesFound === 0) {
  console.log('No invalid nested style objects found!');
} else {
  console.error(`Total issues found: ${issuesFound}`);
}
