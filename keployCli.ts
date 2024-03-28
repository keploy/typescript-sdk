import axios from 'axios';
import * as fs from 'fs';
import { spawn } from 'child_process';

const GRAPHQL_ENDPOINT = '/query';
const HOST = 'http://localhost:';

let SERVER_PORT = 6789;

const setHttpClient = async () => {
    const url = `${HOST}${SERVER_PORT}${GRAPHQL_ENDPOINT}`;
    return axios.create({
        baseURL: url,
        timeout: 30000,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
    });
}

export enum TestRunStatus {
    RUNNING = 'RUNNING',
    PASSED = 'PASSED',
    FAILED = 'FAILED',
    APP_HALTED = 'APP_HALTED',
    USER_ABORT = 'USER_ABORT',
    APP_FAULT = 'APP_FAULT',
    INTERNAL_ERR = 'INTERNAL_ERR'
}

interface RunOptions {
    delay: number;
    debug: boolean;
    port: number;
    path: string;
}

const DEFAULT_RUN_OPTIONS: RunOptions = {
    delay: 5,
    debug: false,
    port: 6789,
    path: '.'
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const Test = async (appCmd: string, runOptions: RunOptions, callback: (err: Error | null, result?: boolean) => void) => {
    const options = { ...DEFAULT_RUN_OPTIONS, ...runOptions };
    // Start Keploy
    RunKeployServer(appCmd, options.delay, options.debug, SERVER_PORT);
    await sleep(5000);
    let testResult = true;
    try {
        const testSets = await FetchTestSets();
        if (!testSets) {
            throw new Error('No test sets found. Are you in the right directory?');
        }
        for (const testSet of testSets) {
            let result = true;
            const { appId, testRunId } = await StartHooks();
            await RunTestSet(testRunId, testSet, appId);
            await StartUserApplication(appId);

            const reportPath = `${options.path}/keploy/reports/${testRunId}/${testSet}-report.yaml`;

            await CheckReportFile(reportPath, options.delay + 15);

            let status: TestRunStatus | null = null;

            console.log(`Test set: ${testSet} is running`);

            while (true) {
                status = await FetchTestSetStatus(testRunId, testSet);
                if (status === TestRunStatus.RUNNING) {
                } else {
                    break;
                }
            }

            if (status !== TestRunStatus.PASSED) {
                result = false;
                console.error(`Test set: ${testSet} failed with status: ${status}`);
                break;
            } else {
                result = true;
                console.log(`Test set: ${testSet} passed`);
            }
            testResult = testResult && result;
            await StopUserApplication(appId);
        }
    } catch (error) {
        callback(error as Error, false);
    } finally {
        await StopKeployServer();
        await sleep(3000)
        callback(null, testResult);
    }
};


const StartUserApplication = async (appId: string): Promise<void> => {
    const client = await setHttpClient();
    const response = await client.post('', {
        query: `mutation StartApp { startApp(appId: ${appId}) }`
    });

    if (!(response.status >= 200 && response.status < 300 && response.data.data.startApp)) {
        throw new Error(`Failed to start user application. Status code: ${response.status}`);
    }
};

const StartHooks = async (): Promise<{ appId: string, testRunId: string }> => {
    const client = await setHttpClient();
    const response = await client.post('', {
        query: `mutation StartHooks { startHooks { appId testRunId } }`
    });

    if (response.status >= 200 && response.status < 300 && response.data.data.startHooks) {
        return {
            appId: response.data.data.startHooks.appId,
            testRunId: response.data.data.startHooks.testRunId
        };
    } else {
        throw new Error(`Failed to start hooks. Status code: ${response.status}`);
    }
};

const RunTestSet = async (testRunId: string, testSet: string, appId: string): Promise<void> => {
    const client = await setHttpClient();
    const response = await client.post('', {
        query: `mutation RunTestSet { runTestSet(testSetId: "${testSet}", testRunId: "${testRunId}", appId: ${appId}) }`
    });

    if (!(response.status >= 200 && response.status < 300 && response.data.data.runTestSet)) {
        throw new Error(`Failed to run test set. Status code: ${response.status}`);
    }
};

const CheckReportFile = async (reportPath: string, timeout: number): Promise<void> => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout * 1000) {
        if (fs.existsSync(reportPath)) {
            return;
        }
        await new Promise(res => setTimeout(res, 1000));
    }
    throw new Error(`Report file not created within ${timeout} seconds`);
};

const FetchTestSetStatus = async (testRunId: string, testSet: string): Promise<TestRunStatus | null> => {
    const client = await setHttpClient();
    const response = await client.post('', {
        query: `query GetTestSetStatus { testSetStatus(testRunId: "${testRunId}", testSetId: "${testSet}") { status } }`
    });

    if (response.status >= 200 && response.status < 300 && response.data.data.testSetStatus) {
        return response.data.data.testSetStatus.status as TestRunStatus;
    } else {
        throw new Error(`Failed to fetch test set status. Status code: ${response.status}`);
    }
};

const StopUserApplication = async (appId: string): Promise<void> => {
    const client = await setHttpClient();
    const response = await client.post('', {
        query: `mutation StopApp { stopApp(appId: ${appId}) }`
    });

    if (!(response.status >= 200 && response.status < 300 && response.data.data.stopApp)) {
        throw new Error(`Failed to stop user application. Status code: ${response.status}`);
    }
};

const StopKeployServer = async (): Promise<void> => {
    const client = await setHttpClient();
    const response = await client.post('', {
        query: `mutation { stopHooks }`
    });

    if (!(response.status >= 200 && response.status < 300 && response.data.data.stopHooks)) {
        throw new Error(`Failed to stop Keploy server. Status code: ${response.status}`);
    }
};

const RunKeployServer = (appCmd: string, delay: number, debug: boolean, port: number): void => {

    const command = `sudo -E env "PATH=$PATH" /usr/local/bin/keploybin test -c "${appCmd}" --coverage --delay ${delay} --port ${port} ${debug ? '--debug' : ''}`;

    const keployProcess = spawn(command, { shell: true });

    // Log stdout
    keployProcess.stdout.on('data', (data) => {
        const log = data.toString();
        console.log(log);
    });

    // Log stderr
    keployProcess.stderr.on('data', (data) => {
        const log = data.toString(); // Convert Buffer to string and trim whitespace
        console.error(log);
    });

    keployProcess.on('error', (error) => {
        console.error(`Error starting Keploy server: ${error}`);
    });

    keployProcess.on('close', (code) => {
        if (code !== 0) {
            console.error(`Keploy server exited with code ${code}`);
        }
    });
};

const FetchTestSets = async (): Promise<string[] | null> => {
    try {
        const client = await setHttpClient();
        const response = await client.post('', {
            query: "{ testSets }"
        });

        if (response.status >= 200 && response.status < 300) {
            return response.data.data.testSets;
        } else {
            console.error(`Error fetching test sets: Status code ${response.status}`);
            return null;
        }
    } catch (error) {
        console.error(`Error fetching test sets: ${error}`);
        return null;
    }
};
