const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
const files = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));

let updatedCount = 0;

for (const file of files) {
  const filePath = path.join(publicDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');

  // Check if nav-links exists
  if (content.includes('class="nav-links"')) {
    // Check if it already has screener
    if (!content.includes('href="/screener"')) {
      // Find the closing </div> for nav-links
      // The structure is usually:
      // <div class="nav-links">
      //    <a ...>...</a>
      //    ...
      // </div>
      
      // We can use a regex to inject it before the closing </div> of the nav-links div.
      // Since regex for matching closing tag can be tricky, we can just find the string.
      const match = content.match(/<div class="nav-links">([\s\S]*?)<\/div>/);
      if (match) {
        const innerContent = match[1];
        // Append our link
        // We will try to preserve the indentation.
        const lastLineMatch = innerContent.match(/(\n\s*)<a/g);
        let indentation = '\n            '; // fallback
        if (lastLineMatch && lastLineMatch.length > 0) {
          const lastMatch = lastLineMatch[lastLineMatch.length - 1];
          indentation = lastMatch.replace('<a', '');
        }

        const newInnerContent = innerContent + indentation + '<a href="/screener">选股器</a>\n        ';
        content = content.replace(match[0], `<div class="nav-links">${newInnerContent}</div>`);
        
        fs.writeFileSync(filePath, content, 'utf-8');
        console.log(`Updated ${file}`);
        updatedCount++;
      }
    } else {
      console.log(`Already has screener in ${file}`);
    }
  }
}

console.log(`Total files updated: ${updatedCount}`);
