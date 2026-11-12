import chalk from 'chalk';
import { getClient } from '../client.js';
import { StudentClient } from '../student-client.js';
import { deletePassword } from '../keychain.js';
import { handleErrors, isJsonMode, emitJson } from '../ui.js';

export default function (program) {
  program
    .command('logout')
    .description('Log out and clear all saved sessions')
    .option('--keep-keychain', 'Keep stored password in macOS Keychain')
    .action(handleErrors(async (options) => {
      const client = getClient(false);
      client.loadSession();
      const studentClient = new StudentClient();
      studentClient.loadSession();

      const username = client.username || studentClient.username;
      client.clearSession();
      studentClient.clearSession();

      let keychainRemoved = false;
      if (!options.keepKeychain && username) {
        keychainRemoved = deletePassword(username);
      }

      if (isJsonMode()) {
        emitJson({ ok: true, loggedOut: true, keychainRemoved });
        return;
      }
      console.log(chalk.yellow('Logged out (ODTUClass + Student Portal sessions cleared).'));
    }));
}
