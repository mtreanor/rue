const fs = require('fs');
let msg = fs.readFileSync(0, 'utf-8');
// Remove Co-authored-by: Cursor line and any trailing whitespace/newlines
msg = msg.replace(/\s*Co-authored-by:\s*Cursor\s*<cursoragent@cursor\.com>\s*$/gi, '\n');
msg = msg.trim() + '\n';
process.stdout.write(msg);
