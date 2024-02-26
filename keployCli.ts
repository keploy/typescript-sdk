import axios from 'axios';
import { exec, spawn, ChildProcess } from 'child_process';
import kill from 'tree-kill';

const GRAPHQL_ENDPOINT = '/query';
const HOST = 'http://localhost:';

let serverPort = 6789;

export enum TestRunStatus {
    RUNNING = 'RUNNING',
    PASSED = 'PASSED',
    FAILED = 'FAILED'
}

interface TestOptions {
    maxTimeout: number;

}

let hasTestRunCompleted = false;

export const setTestRunCompletionStatus = (status: boolean) => {
    hasTestRunCompleted = status;
};

let userCommandPID: any = 0;

export const Test = async (appCmd: string, options: TestOptions, callback: (err: Error | null, result?: boolean) => void) => {
    // set default values
    if (appCmd == "") {
        appCmd = "npm start"
    }
    if (options.maxTimeout === 0 || options.maxTimeout === undefined || options.maxTimeout === null) {
        options.maxTimeout = 30000;
    }

    let testResult = true;
    let startTime = Date.now();
    try {
        const testSets = await FetchTestSets();
        if (testSets === null) {
            throw new Error('Test sets are null');
        }
        console.log("TestSets: ", [...testSets]);
        console.log("starting user application");
        for (let testset of testSets) {
            let result = true;
            StartUserApplication(appCmd)
            const testRunId = await RunTestSet(testset);
            let testRunStatus;
            while (true) {
                await new Promise(res => setTimeout(res, 2000));
                testRunStatus = await FetchTestSetStatus(testRunId);
                // break the loop if the testRunStatus is not running or if it's been more than `maxTimeout` milliseconds
                if (testRunStatus !== TestRunStatus.RUNNING) {
                    break;
                }
                if (Date.now() - startTime > options.maxTimeout) {
                    console.log("Timeout reached, exiting loop. maxTimeout: ", options.maxTimeout);
                    break;
                }
                console.log("testRun still in progress");
                // break;
            }

            if (testRunStatus === TestRunStatus.FAILED || testRunStatus === TestRunStatus.RUNNING) {
                console.log("testrun failed");
                result = false;
            } else if (testRunStatus === TestRunStatus.PASSED) {
                console.log("testrun passed");
                result = true;
            }
            console.log(`TestResult of [${testset}]: ${result}`);
            testResult = testResult && result;
            StopUserApplication()
            await new Promise(res => setTimeout(res, 5000)); // wait for the application to stop
        }
        // stop the ebpf hooks
        stopTest();
        callback(null, testResult); // Callback with no error and the test result
    } catch (error) {
        callback(error as Error); // Callback with the error cast to an Error object
    }
}

export const StartUserApplication = (userCmd: string) => {
    const [cmd, ...args] = userCmd.split(' ');
    const npmStartProcess = spawn(cmd, args, {
        stdio: [process.stdin, 'pipe', process.stderr],
    });
    userCommandPID = npmStartProcess.pid
}

export const StopUserApplication = () => {
    kill(userCommandPID)
}
let childProcesses: ChildProcess[] = [];
const processWrap = (command: string): Promise<void> => {
    return new Promise((resolve, reject) => {
        let isPromiseSettled = false;
        const [cmd, ...args] = command.split(' ');

        const childProcess = spawn(cmd, args, { shell: true });

        const cleanup = () => {
            if (!isPromiseSettled) {
                isPromiseSettled = true;
                childProcesses = childProcesses.filter(cp => cp !== childProcess);
                if (!childProcess.killed) {
                    childProcess.kill();
                }
                resolve(); // or reject based on your requirement
            }
        };

        if (!isPromiseSettled) {
            childProcess.stdout.on('data', (data) => {
                console.log(`stdout: ${data}`);
            });

            childProcess.stderr.on('data', (data) => {
                console.log(`stderr: ${data}`);
            });

            childProcess.on('error', (error) => {
                console.error(`Failed to start process: ${error.message}`);
                cleanup();
            });
        }
        childProcess.on('exit', (code, signal) => {
            if (code !== 0 && signal !== "SIGTERM") {
                reject(new Error(`Process exited with code: ${code}, signal: ${signal}`));
            } else {
                resolve();
            }
            cleanup();
        });

        childProcess.on('close', () => {
            cleanup();
        });

        childProcesses.push(childProcess);
    });
};

export const cleanupProcesses = () => {
    childProcesses.forEach(cp => {
        try {
            if (!cp.killed) {
                if (cp.stdout) {
                    cp.stdout.destroy();
                }
                if (cp.stderr) {
                    cp.stderr.destroy();
                }
                if (cp.stdin) {
                    cp.stdin.destroy();
                }
                cp.kill();
            }
        } catch (error) {
            //console.error(`Failed to kill process: ${error}`);
        }
    });
    childProcesses.length = 0;  // A way to clear the array without reassigning
};

process.on('exit', cleanupProcesses);

export const RunKeployServer = (pid: number, delay: number, testPath: string, port: number) => {
    return new Promise<void>(async (resolve, reject) => {
        let kprocess: ChildProcess | null = null;
        const cleanup = () => {
            process.off('exit', cleanup);
            process.off('SIGINT', cleanup);
            process.off('SIGTERM', cleanup);

            if (kprocess) {
                kprocess.kill();
            }
            cleanupProcesses();
        };
        process.on('exit', cleanup);
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        const command = [
            'sudo',
            '-S',
            'keploybin',
            'serve',
            `--pid=${pid}`,
            `-p=${testPath}`,
            `-d=${delay}`,
            `--port=${port}`,
            `--language="js"`
        ];
        if (port !== 0) {
            serverPort = port;
        }
        if (!hasTestRunCompleted) {
            try {
                await processWrap(command.join(' '))
                    .then(() => {
                        if (hasTestRunCompleted) {
                            resolve();
                        }
                    })
                    .catch(error => {
                        reject(error);
                    });
            } catch (error) {
                reject(error);
            }
        } else {
            resolve();
        }


    });
}

export const setHttpClient = async () => {
    try {
        const url = `${HOST}${serverPort}${GRAPHQL_ENDPOINT}`;
        return axios.create({
            baseURL: url,
            timeout: 10000,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
        });
    } catch (error) {
        throw error; // Re-throw the error after logging it
    }
}

export const FetchTestSets = async (): Promise<string[] | null> => {
    try {
        const client = await setHttpClient();
        if (!client) throw new Error("Could not initialize HTTP client.");

        const response = await client.post('', {
            query: "{ testSets }"
        });

        if (response.status >= 200 && response.status < 300) {
            return response.data.data.testSets;
        } else {
            //////console.error('Error: Unexpected response status', response.status);
            return null;
        }
    } catch (error) {
        if (error instanceof Error) {
            console.error('Error fetching test sets', error.message, error.stack);
        } else {
            console.error('An unknown error occurred while fetching test sets', error);
        }
    }
    return null;
};

const stopTest = async (): Promise<boolean> => {
    try {
        const client = await setHttpClient();
        if (!client) throw new Error("Could not initialize HTTP client.");
        const response = await client.post('', {
            query: `{ stopTest }`
        });
        if (response.status >= 200 && response.status < 300) {
            if (response.data && response.data.data) {
                return response.data.data.stopTest;
            } else {
                console.error('Unexpected response structure', response.data);
                return false;
            }
        }
    } catch (error) {
        console.error('Error stopping the test', error);
    }
    return false;
};

export const FetchTestSetStatus = async (testRunId: string): Promise<TestRunStatus | null> => {
    try {
        const client = await setHttpClient();
        if (!client) throw new Error("Could not initialize HTTP client.");
        const response = await client.post('', {
            query: `{ testSetStatus(testRunId: "${testRunId}") { status } }`
        });
        if (response.status >= 200 && response.status < 300) {
            if (response.data && response.data.data && response.data.data.testSetStatus) {
                const testStatus = response.data.data.testSetStatus.status as keyof typeof TestRunStatus;
                return TestRunStatus[testStatus];
            } else {
                console.error('Unexpected response structure', response.data);
                return null;
            }
        }
    } catch (error) {
        console.error('Error fetching test set status', error);
    }
    return null;
};

export const RunTestSet = async (testSetName: string): Promise<string> => {
    try {
        const client = await setHttpClient();
        if (!client) throw new Error("Could not initialize HTTP client.");

        const response = await client.post('', {
            query: `mutation { runTestSet(testSet: "${testSetName}") { success testRunId message } }`
        });
        if (response.data && response.data.data && response.data.data.runTestSet) {
            return response.data.data.runTestSet.testRunId;
        } else {
            console.error('Unexpected response format:', response.data);
        }
    } catch (error) {
        console.error('Error running test set', error);
    }
    return " ";
};

export const StopKeployServer = () => {
    return killProcessOnPort(serverPort);
};

export const killProcessOnPort = async (port: number): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
        //console.debug(`Trying to kill process running on port: ${port}`);
        const command = `lsof -t -i:${port}`;

        exec(command, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error executing command: ${stderr}`, error);
                return reject(error);
            }

            const pids = stdout.split('\n').filter(pid => pid);
            console.log(`PIDs found: ${pids}`);  // Logging the PIDs found

            if (pids.length === 0) {
                console.error(`No process found running on port: ${port}`);
                return resolve();
            }

            try {
                const jestPid = process.pid.toString();  // Get the PID of the Jest process
                const filteredPids = pids.filter(pid => pid !== jestPid);  // Filter out the Jest PID from the list of PIDs

                for (let pid of filteredPids) {
                    try {
                        await forceKillProcessByPID(parseInt(pid.trim(), 10));
                    } catch (error) {
                        console.error(`Failed to kill process ${pid}:`, error);
                    }
                }
                resolve();
            } catch (error) {
                console.error(`Error killing processes:`, error);
                reject(error);
            }
        });
    });
};

export const forceKillProcessByPID = (pid: number): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
        try {
            if (process?.getuid) {
                process.kill(pid, 'SIGKILL');
                resolve();
            } else {
                //console.error(`Script is not run as root, cannot kill process with pid ${pid}`);
                reject(new Error(`EPERM: Not running as root`));
            }
        } catch (error) {
            console.error(`Error killing process with pid ${pid}`, error);
            reject(error);
        }
    });
};
