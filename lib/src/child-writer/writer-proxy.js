/*
 * Copyright 2016 Resin.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const Bluebird = require('bluebird');
const childProcess = require('child_process');
const isElevated = Bluebird.promisify(require('is-elevated'));
const _ = require('lodash');
const os = require('os');
const fs = require('fs');
const Tail = require('tail').Tail;
const sudoPrompt = Bluebird.promisifyAll(require('sudo-prompt'));
const EXIT_CODES = require('../exit-codes');
const packageJSON = require('../../../package.json');
const CONSTANTS = require('./constants');
const utils = require('./utils');

// This script is in charge of spawning the writer process and
// ensuring it has the necessary privileges. It might look a bit
// complex at first sight, but this is only because elevation
// modules don't work in a spawn/fork fashion.
//
// This script spawns the writer process and redirects its `stdout`
// to a temporary 'log file', which is tailed by this same script.
// The output is then parsed, and sent as IPC messages to the
// parent process, taking care of the writer elevation as needed.

const EXECUTABLE = process.argv[0];
const ETCHER_ARGUMENTS = process.argv.slice(2);

Bluebird.try(function() {
  if (!process.env[CONSTANTS.TEMPORARY_LOG_FILE_ENVIRONMENT_VARIABLE]) {
    return utils.getTemporaryLogFilePath().then(function(logFilePath) {
      process.env[CONSTANTS.TEMPORARY_LOG_FILE_ENVIRONMENT_VARIABLE] = logFilePath;
    });
  }
}).then(function() {
  return isElevated();
}).then(function(elevated) {
  const logFile = process.env[CONSTANTS.TEMPORARY_LOG_FILE_ENVIRONMENT_VARIABLE];

  if (process.send) {

    // Sadly, `fs.createReadStream()` won't work since
    // the stream that function returns gets closed
    // when it initially reaches EOF, instead of waiting
    // for the file to receive more data.
    const tail = new Tail(logFile);

    tail.on('error', function(error) {
      console.error(error);
      process.exit(1);
    });

    tail.on('line', function(line) {
      const data = utils.parseEtcherCLIRobotLine(line);

      if (data) {
        process.send(data);
      }
    });
  }

  if (!elevated) {

    if (os.platform() === 'win32') {
      const elevator = Bluebird.promisifyAll(require('elevator'));
      return elevator.executeAsync([
        'set ELECTRON_RUN_AS_NODE=1 &&',
        `set ${CONSTANTS.TEMPORARY_LOG_FILE_ENVIRONMENT_VARIABLE}=${logFile} &&`
      ].concat(process.argv), {}).then(function(stdout, stderr) {
        if (!_.isEmpty(stderr)) {
          throw new Error(stderr);
        }
      });
    }

    const command = [

      // Some elevation tools, like `pkexec` or `kdesudo`, don't
      // provide a way to preserve the environment, therefore we
      // have to make sure the environment variables we're interested
      // in are manually inherited.
      'env',
      'ELECTRON_RUN_AS_NODE=1',
      `${CONSTANTS.TEMPORARY_LOG_FILE_ENVIRONMENT_VARIABLE}=${logFile}`

    ].concat(utils.escapeWhiteSpacesFromArguments(process.argv)).join(' ');

    return sudoPrompt.execAsync(command, {
      name: packageJSON.displayName
    }).then(function(stdout, stderr) {
      if (!_.isEmpty(stderr)) {
        throw new Error(stderr);
      }
    });

  }

  return new Bluebird(function(resolve, reject) {
    const logFileWriteStream = fs.createWriteStream(logFile, {
      flags: 'w'
    });

    logFileWriteStream.on('error', reject);

    // We have to wait for the WriteStream to open
    // before passing it to spawn's `stdio`, otherwise we get:
    //
    //   Incorrect value for stdio stream
    //
    // See https://github.com/nodejs/node-v0.x-archive/issues/4030
    logFileWriteStream.on('open', function() {

      const child = childProcess.spawn(EXECUTABLE, ETCHER_ARGUMENTS, {
        stdio: [ 'ignore', logFileWriteStream, 'pipe' ]
      });

      child.stderr.on('data', function(data) {
        return reject(data.toString());
      });

      child.on('error', reject);
      child.on('close', resolve);
    });
  });

}).then(function(exitCode) {
  process.exit(exitCode);
}).catch(function(error) {
  console.error(error);
  process.exit(EXIT_CODES.GENERAL_ERROR);
});
