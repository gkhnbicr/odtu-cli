import chalk from 'chalk';
import { getClient } from '../client.js';
import { StudentClient } from '../student-client.js';
import { deletePassword, getRetryDeleteCommand } from '../keychain.js';
import { handleErrors, isJsonMode, emitJson } from '../ui.js';

export default function (program) {
  program
    .command('logout')
    .description('Log out and clear all saved sessions')
    .option('--keep-keychain', 'Keep stored password in OS credential store')
    .action(handleErrors(async (options) => {
      const client = getClient(false);
      client.loadSession();
      const studentClient = new StudentClient();
      studentClient.loadSession();

      const usernames = [...new Set([client.username, studentClient.username].filter(Boolean))];
      client.clearSession();
      studentClient.clearSession();

      const keychainResults = [];
      if (!options.keepKeychain) {
        for (const username of usernames) {
          const res = deletePassword(username);
          keychainResults.push({ username, ...res });
        }
      }

      const keychainRemoved = keychainResults.some((r) => r.removed);
      const keychainFailed = keychainResults.filter((r) => !r.ok);

      if (keychainFailed.length > 0) {
        process.exitCode = 1;
      }

      if (isJsonMode()) {
        emitJson({
          ok: keychainFailed.length === 0,
          loggedOut: true,
          keychainRemoved,
          keychainResults,
        });
        return;
      }
      console.log(chalk.yellow('Logged out (ODTUClass + Student Portal sessions cleared).'));
      for (const failure of keychainFailed) {
        console.error(
          chalk.red(`Warning: failed to remove credential for ${failure.username}: ${failure.error}`),
        );
        const retryCmd = getRetryDeleteCommand(failure.username);
        if (retryCmd) {
          console.error(chalk.dim(`Retry manually: ${retryCmd}`));
        }
      }
    }));
}
