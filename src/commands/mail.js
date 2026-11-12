import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import boxen from 'boxen';
import { getClient } from '../client.js';
import { StudentClient } from '../student-client.js';
import { getPassword } from '../keychain.js';
import { handleErrors, spinner, createTable, isJsonMode, emitJson } from '../ui.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAP_HELPER = join(__dirname, '..', 'imap_helper.py');
const IMAP_HOST = 'imap.metu.edu.tr';
const IMAP_PORT = 993;

function resolveUsername(explicitUser) {
  if (explicitUser) return explicitUser;
  const moodle = getClient(false);
  if (moodle.loadSession() && moodle.username) return moodle.username;
  const student = new StudentClient();
  if (student.loadSession() && student.username) return student.username;
  return null;
}

function runImap(payload) {
  const res = spawnSync('python3', [IMAP_HELPER], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 25 * 1024 * 1024,
  });
  if (res.error) throw new Error(`Failed to start python3 IMAP helper: ${res.error.message}`);
  if (res.status !== 0) {
    let errMsg = (res.stderr || res.stdout || '').trim();
    try {
      const parsed = JSON.parse(errMsg);
      if (parsed.error) errMsg = parsed.error;
    } catch { /* use raw stderr */ }
    throw new Error(errMsg || `IMAP helper exited with code ${res.status}`);
  }
  return JSON.parse(res.stdout);
}

export default function (program) {
  program
    .command('mail [uid]')
    .description('Read METU email via IMAP (read-only, uses Keychain password)')
    .option('-n, --limit <count>', 'Max messages to list', '15')
    .option('-f, --folder <folder>', 'IMAP folder name', 'INBOX')
    .option('-s, --search <query>', 'Search subject/from/body')
    .option('--unread', 'Show only unread messages')
    .option('--folders', 'List available IMAP folders')
    .option('--html', 'Include raw HTML body when reading a message')
    .option('--save-attachments <dir>', 'Save attachments of a message to directory')
    .option('-u, --user <username>', 'METU username override')
    .action(handleErrors(async (uid, options) => {
      const username = resolveUsername(options.user);
      if (!username) {
        throw new Error('No METU username found. Run `odtu login` or pass --user <username>.');
      }
      const password = getPassword(username);
      if (!password) {
        throw new Error(`No password found in Keychain (or ODTU_PASSWORD) for ${username}. Run \`odtu login\`.`);
      }

      const s = spinner('Connecting to METU IMAP...').start();
      let action = 'list';
      if (options.folders) action = 'folders';
      else if (uid) action = 'read';

      const data = runImap({
        host: IMAP_HOST,
        port: IMAP_PORT,
        username,
        password,
        action,
        folder: options.folder,
        limit: parseInt(options.limit, 10) || 15,
        search: options.search || null,
        unread: !!options.unread,
        uid: uid ? parseInt(uid, 10) : null,
        includeHtml: !!options.html,
        saveAttachments: options.saveAttachments ? resolve(options.saveAttachments) : null,
      });
      s.stop();

      if (isJsonMode()) {
        emitJson(data);
        return;
      }

      if (action === 'folders') {
        const table = createTable(['Folder', 'Flags']);
        for (const f of data.folders) {
          table.push([chalk.bold(f.name || f.raw || '?'), chalk.dim(f.flags || '')]);
        }
        console.log(table.toString());
        return;
      }

      if (action === 'read') {
        const lines = [
          `${chalk.dim('From:')} ${data.from}`,
          `${chalk.dim('To:')}   ${data.to}`,
          data.cc ? `${chalk.dim('Cc:')}   ${data.cc}` : null,
          `${chalk.dim('Date:')} ${data.dateRaw || data.date}`,
          `${chalk.dim('UID:')}  ${data.uid} (${data.seen ? 'read' : 'unread'})`,
          '',
          data.text || chalk.dim('(empty body)'),
        ].filter(x => x !== null);

        if (data.attachments?.length) {
          lines.push('', chalk.bold('Attachments:'));
          for (const a of data.attachments) {
            const saved = a.savedPath ? ` -> ${a.savedPath}` : '';
            lines.push(`  - ${a.filename} (${a.contentType}, ${a.bytes} B)${saved}`);
          }
        }
        if (data.links?.length) {
          lines.push('', chalk.bold('Links:'));
          for (const l of data.links.slice(0, 20)) lines.push(`  - ${l}`);
        }

        console.log(boxen(lines.join('\n'), {
          title: `  ${chalk.bold(data.subject)}  `,
          titleAlignment: 'left',
          borderColor: 'magenta',
          padding: 1,
          margin: { top: 1, bottom: 1, left: 2, right: 2 },
        }));
        return;
      }

      if (!data.messages.length) {
        console.log(chalk.yellow('No messages found.'));
        return;
      }

      console.log(chalk.bold(`\n  ${data.folder} (${data.totalMatching} matching)\n`));
      const table = createTable(['UID', 'Status', 'Date', 'From', 'Subject']);
      for (const m of data.messages) {
        table.push([
          chalk.dim(String(m.uid)),
          m.seen ? chalk.dim('read') : chalk.yellow('UNREAD'),
          chalk.dim((m.date || m.dateRaw || '').slice(0, 16).replace('T', ' ')),
          (m.from || '').slice(0, 32),
          chalk.bold((m.subject || '').slice(0, 60)),
        ]);
      }
      console.log(table.toString());
      console.log(chalk.dim('\n  Read full message with: odtu mail <UID>\n'));
    }));
}
