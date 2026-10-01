/** Trusted host-side custodian. The workload still executes inside its boundary. */
export const WORKSPACE_PROCESS_CUSTODY_SCRIPT = String.raw`
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const [executable, ...args] = JSON.parse(process.argv[1]);
const control = fs.createReadStream(null, {fd: 3});
let started = false;
const terminateOwnGroup = () => {
  // This process is spawned as its group's detached leader. Never take a PID
  // from an external request, persisted state, or the workload.
  process.kill(-process.pid, 'SIGKILL');
};
control.on('end', terminateOwnGroup);
control.on('error', terminateOwnGroup);
control.on('data', data => {
  if (started || data.toString() !== 'start') return terminateOwnGroup();
  started = true;
  const child = spawn(executable, args, {stdio: 'inherit', detached: false});
  child.once('error', error => {
    process.stderr.write('Workspace command spawn failed: ' + error.message + '\n');
    fs.writeSync(3, JSON.stringify({exitCode: 1}) + '\n');
    terminateOwnGroup();
  });
  child.once('exit', (exitCode, signal) => {
    // Send the actual child result before removing the complete owned group,
    // including background descendants. Only the trusted custodian owns fd 3.
    fs.writeSync(3, JSON.stringify({exitCode, signal}) + '\n');
    terminateOwnGroup();
  });
});
`;
