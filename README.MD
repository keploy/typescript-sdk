[![contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen?logo=github)](CODE_OF_CONDUCT.md)
[![Slack](.github/slack.svg)](https://join.slack.com/t/keploy/shared_invite/zt-12rfbvc01-o54cOG0X1G6eVJTuI_orSA)
[![License](.github/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Note** :- Issue Creation is disabled on this Repository, please visit [here](https://github.com/keploy/keploy/issues/new/choose) to submit issue.

# Keploy Typescript-SDK
This is the client SDK for the [Keploy](https://github.com/keploy/keploy) testing platform. With the TypeScript SDK, you can test both your existing unit test cases in Jest and create new end-to-end test cases for your applications.
The **HTTP mocks/stubs and tests are the same format** and inter-exchangeable.

## Contents
1. [Installation](#installation)
2. [Usage](#usage)
3. [Community support](#community-support)

## Installation
1. First install [Node.js](https://nodejs.org/en/download). Then,
```bash
# for npm package manager
npm i @keploy/typescript-sdk
```
```bash
# for yarn package manager
yarn add @keploy/typescript-sdk
```

2. Install and Start the keploy binary on an independent terminal. Follow [this](https://github.com/keploy/keploy#quick-installation) guide

3. Finally, install nyc as a development dependency using npm or yarn:
```bash
# for npm package manager
npm install --save-dev nyc
```
```bash
# for yarn package manager
yarn add --dev nyc
```
With nyc installed, you can now use it to analyze code coverage for both unit and end-to-end test cases in your project

## Usage
### Unit and End-to-End Testing with Keploy
Keploy simplifies the testing process by seamlessly generating end-to-end test cases without the need to write unit test files and manage mocks/stubs.

 1. **Enabling Coverage** 
    To add the specified coverage-related scripts to your <b>package.json</b> file, you can include the following statement within the "scripts" section:
    ``` bash
            "scripts": {
                // ... other scripts
                "test": "jest",
                "coverage": "nyc npm test && npm run coverage:merge && npm run coverage:report",
                "coverage:merge": "nyc merge ./coverage .nyc_output/out.json",
                "coverage:report": "nyc report --reporter=lcov --reporter=text",
                // ... other scripts
            }
    ```
 2. **A testfile to run and display coverage**
    Create a test file that execute Keploy's end-to-end test cases along with unit testcases.  It can be called as ```Keploy.test.js```

    The contents of the file will be
    ```bash
        const {
            KeployTest,
            Config,
        } = require('@keploy/typescript-sdk/dist/keployCli');

        const timeOut = 300000;

        const { expect } = require('@jest/globals');
        describe('Keploy Server Tests', () => {
            test('TestKeploy', async () => {
                // testResult = await KeployTest()
                const config = new Config('npm start')
                testResult =  await KeployTest(config)
                //by default command is set to "npm start", incase of custom command update the keployTest as shown above
                expect(testResult).toBeTruthy();
            }, timeOut);
        }, timeOut);
    ```
3. **Test** 
    Execute
    ```bash
        keploy test -c "npm test" --delay 10
    ```

🎉TADA: You've successfully tested end-to-end test cases alongside unit test cases without the need to write additional test files or manage mocks/stubs.
    

## Community support
We'd love to collaborate with you to make Keploy.io great. To get started:
* [Slack](https://join.slack.com/t/keploy/shared_invite/zt-12rfbvc01-o54cOG0X1G6eVJTuI_orSA) - Discussions with the community and the team.
* [GitHub](https://github.com/keploy/keploy/issues) - For bug reports and feature requests.