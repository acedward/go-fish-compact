import * as fs from 'fs';
import * as path from 'path';

const LOG_FILE = path.join(process.cwd(), 'go-fish-debug.log');

// Clear log file on start
try {
  fs.writeFileSync(LOG_FILE, `--- Go Fish Debug Log ---\nStarted: ${new Date().toISOString()}\n\n`);
} catch (e) {
  // Ignore if we can't write
}

export function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] ${message}`;
  
  if (data !== undefined) {
    try {
      line += '\n  Data: ' + JSON.stringify(data, (_, v) => 
        typeof v === 'bigint' ? v.toString() + 'n' : v
      , 2).replace(/\n/g, '\n  ');
    } catch (e) {
      line += '\n  Data: [unable to serialize]';
    }
  }
  
  line += '\n';
  
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    // Ignore write errors
  }
}

export function logError(message: string, error: any) {
  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] ERROR: ${message}\n`;
  
  if (error) {
    line += `  Message: ${error.message || error}\n`;
    if (error.stack) {
      line += `  Stack: ${error.stack}\n`;
    }
  }
  
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    // Ignore write errors
  }
}
