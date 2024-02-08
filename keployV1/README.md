[![contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen?logo=github)](CODE_OF_CONDUCT.md)
[![Slack](.github/slack.svg)](https://join.slack.com/t/keploy/shared_invite/zt-12rfbvc01-o54cOG0X1G6eVJTuI_orSA)
[![License](.github/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Note** :- Issue Creation is disabled on this Repository, please visit [here](https://github.com/keploy/keploy/issues/new/choose) to submit issue.

# Keploy Typescript-SDK
This is the client SDK for the [Keploy](https://github.com/keploy/keploy) testing platform. You can use this to generate realistic mock files or entire e2e tests for your applications. The **HTTP mocks/stubs and tests are the same format** and inter-exchangeable.

## Contents
1. [Installation](#installation)
2. [Usage](#usage)
3. [Supported Routers](#supported-routers)
4. [Supported Dependencies](#supported-dependencies)
5. [Sample unit test for Mocking/Stubing](#sample-unit-test-for-mockingstubing)
6. [Test with code coverage](#test-with-code-coverage)
7. [Development Setup](#development-setup)
8. [Community support](#community-support)

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
## Usage
### Generate E2E tests
Keploy can generate end-to-end tests without writing any unit tests file and mocks. 
Mocks/stubs are also generated and linked to their respective tests. 
These tests can be run just by starting your API server on `test` mode. 
We can also add code coverage using the recorded tests. Steps for integration: 
 1. **Integration** 
    1. `Add keploy middleware` to your API server. Follow the [Supported Routers](#supported-routers) guide for your router framework.
    2. `Wrap the dependencies` of your API server like mongoose, etc. Follow the [Supported Dependencies](#supported-dependencies) guide for your dependencies.
    3. `Configuration`: SDK uses environment variables for configuration. "KEPLOY_APP_PORT" is mandatory during, "record"/"test" modes. Other environment variables are optional, since they have default values.

        Following is an example of `.env` file configuration.
        ``` bash
            export KEPLOY_APP_PORT=XXXX        # port on which API is running. Required and it should be a number
            export KEPLOY_MODE="off"           # Values: "record" / "test" / "off"(default) 
            export KEPLOY_APP_NAME="my-app"    # [app_ids] for different API applications. Default: "sample-app"
            export KEPLOY_APP_HOST="localhost" # Host of API application. Default: "localhost"
            export KEPLOY_APP_DELAY=5          # approx time taken by API server to start. Default: 5sec
            export KEPLOY_APP_TIMEOUT=100      # request timeout for keploy server. Default: 60sec
            # export KEPLOY_APP_FILTER={"urlRegex":"*"}  # filters for capturing tcs. It should be a valid JSON

            export KEPLOY_SERVER_URL="localhost:6789" # url to running keploy server. Default: "localhost:6789"
            # export KEPLOY_SERVER_LICENSE="XXX-XXX-XXX" # hosted keploy server api key
        ```
 2. **Record**
    1. Set the `KEPLOY_MODE` to "record" in your .env configuration file.
       ```bash
       export KEPLOY_MODE="record"
       ```
    2. Start your API server on `record` mode. 
       ```bash
       # <server>.js should be the main file to start API server.
       source .env && node <server>.js
       ```
    3. `Make an API call` on any endpoint of your running API server.

    Now, testcases will be generated for the API call along with the integrated dependencies mocks/stubs. These tests and mocks are generated as `readable/editable` yaml files in the */keploy* directory.
3. **Test** 
    1. Set the `KEPLOY_MODE` to "test" in your .env configuration file.
       ```bash
       export KEPLOY_MODE="test"
       ```
    2. Start your API server on `test` mode. 
       ```bash
       # <server>.js should be the main file to start API server.
       source .env && node <server>.js
       ```

    🎉TADA: You have made an end-to-end test and tested it without writing any code for test file or managing mocks/stubs.
    
Keploy can be integrated with testing frameworks like Mocha.js for `code coverage`. 
Integartion with fameworks is provided in [Test with code coverage](#test-with-code-coverage) section.
### Mocking/Stubbing for unit tests
These mocks/stubs are realistic and frees you up from writing them manually. Keploy creates `readable/editable` mocks/stubs yaml files which can be referenced in any of your unit-tests tests. Steps to mock/stub external calls:

1. **Wrap the dependencies**: 
   1. `Initialise keploy context` by calling mock.NewContext in test setup for each testcase. 
      ```js
      const { NewContext } = require('typescript-sdk/dist/mock/mock');
      // Set your keploy mode and test name of unit test here.
      NewContext({Mode: "<record_OR_test_OR_off>", Name: "unique_testcase_name"})  
      ```
   2. `Wrap the dependencies` of your unit tests like mongoose, etc. Follow the [Supported Dependencies](#supported-dependencies) guide for your dependencies.
2. **Record**: 
   1. Set the mode to `record` in NewContext.
      ```js
      // input a unique test name for each testcase in the Name field
      NewContext({Mode: "record", Name: "unit_test-1"})  
      ```
   2. Run your unit test. 
   
   Now, a */mocks* directory is created containing yaml file for each testcase of your unit test. 
   The yaml files contains the recorded `outputs` of external depedencies as yaml docs.
3. **Test**: 
   1. Set the mode to `test` in your test setup.
      ```js
      // input a unique test name for each testcase in the Name field
      NewContext({Mode: "test", Name: "unit_test-1"})  
      ```
   2. Turn off the dependency service like mongoDB server, etc.
   3. Run the unit test. 
   
   🎉TADA: The unit test will run perfectly, without making any external dependency call. 
   It uses the recorded outputs from yaml files in generated mocks directory.

An example is provided in [Sample unit test for Mocking/Stubing](#sample-unit-test-for-mockingstubing) section.

## Supported Routers
### 1. Express
Keploy adds a middleware for capturing requests/responses using require hooks. To integrate, just add the following statement before `every require` statement of `express` in your app.
```js
// Uncomment following blocks to use require in ES Module
/*
import { createRequire } from "module";
const require = createRequire(import.meta.url);
*/
require("typescript-sdk/dist/integrations/express/register");
/*
const express = require('express');
*/
```

Example of CommonJS module express app:
```js
require("typescript-sdk/dist/integrations/express/register");
const express = require('express');
const app = express();
const port = process.env.PORT || 5050;

app.use(express.json());

app.get("/", (req, res) => {
  res.json({"field": "App is healthy", "opacity": Math.random()})
})

app.listen(port, () => {
    console.log(`Server is running on port: ${port}`);
})
```

## Supported Dependencies
### 1. Octokit
To integrate, just add this line before `every require` statement of Octokit in your application.
```js
// Uncomment following blocks to use require in ES Module
/*
import { createRequire } from "module";
const require = createRequire(import.meta.url);
*/
require("typescript-sdk/dist/integrations/octokit/require")
/*
const { Octokit, App } = require("octokit");
*/
```

### 2. Mongoose
To integrate, just add this line before `every require` statement of mongoose in your application.
```js
// Uncomment following blocks to use require in ES Module
/*
import { createRequire } from "module";
const require = createRequire(import.meta.url);
*/
require("typescript-sdk/dist/integrations/mongoose/require")
/*
const mongoose =  require('mongoose');
*/
```
Mongoose package version should be `^6.4.0`. Keploy mocks/stubs outputs for following mongoose methods:
1. find()
2. findOne()
3. save()
4. create()
5. insertMany()
6. updateOne()
7. updateMany()
8. deleteOne()
9. deleteMany()

## Sample unit test for Mocking/Stubing

Following is an example of `CommonJS` module unit test with octokit dependency :

#### Example
```js
require("typescript-sdk/dist/integrations/octokit/require")
var {NewContext} = require ("typescript-sdk/dist/mock/mock")
var assert = require('assert');
const { Octokit, App } = require("octokit");
describe('routes', function () {
    var server, octokit;
    beforeEach(function () {
        NewContext({Mode: "<record_OR_test_OR_off>", Name: "your demo app name"})  // Set your keploy mode and name here.
        octokit = new Octokit({ auth: "<your_authentication_token>"});

    });
    // Test to make sure URLs respond correctly.
    it("url/", async function () {
        return new Promise(function(resolve){
            const app = new App({
                appId: "<APP_ID>",
                privateKey: `<PEM_FILE>`, 
            })
            const { data: slug } = app.octokit.rest.apps.getAuthenticated().then((result) => {

                app.getInstallationOctokit(<InstallationId>).then((octokit) => {
                    octokit.rest.issues.create({
                    owner: "LOREM",
                    repo: "IPSUM",
                    title: "Hello " + "World",
                    }).then((res) => {
                        assert.equal(true, true)
                        resolve()
                    });
                });
            });
        })
    });
});
```

**Note**: Since, this package uses require-in-the-middle for adding hook. Therefore, it is supported for commonjs module currently. Also, you can use require statements in esmodule by:
```js
// Define "require"
import { createRequire } from "module";
const require = createRequire(import.meta.url);
```

## Test with code coverage
### Integration with Mocha testing framework 
To see code coverage please use nyc mocha and see how many lines are covered!!

You just need to create a unit test file with the following code. And that's it!!🔥🔥🔥
```js
const {runServer} = require('../server') //your server wrapper
const {keploy}  = require('typescript-sdk/dist/integrations/express/register')
const {describe,test,before,after}=  require('mocha')
describe("test function", ()=>{
    before( (done)=>{
            keploy.setTestMode();
            runServer()
            done()
          })
    test("should be running", async ()=> {
      return keploy.assertTests();
    });
    after(()=>{
         process.exit(1); //exits the node server
       })
})
```

Note:- Since, Jest framework have an isolated environment. Keploy is unable to add hooks for integration.

## Development Setup

- This project uses [Yarn](https://yarnpkg.com/) for package management. To install yarn, please make sure [Node](https://nodejs.org/en/) is installed and then:

```sh
npm i -g yarn
```

- To install local dependencies, assuming you are at root of the project:

```sh
yarn install
```

- To generate the js grpc files from services.proto: 
```sh
yarn proto-loader-gen-types --grpcLib=@grpc/grpc-js --outDir=proto/ proto/*.proto
```
- For VSCode setup, make sure these extensions are installed:
  - [EditorConfig](https://marketplace.visualstudio.com/items?itemName=EditorConfig.EditorConfig)
  - [Eslint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)

- Furthermore, to commit your changes use `yarn commit` instead of `git commit` for better commit experience.

## Community support
We'd love to collaborate with you to make Keploy.io great. To get started:
* [Slack](https://join.slack.com/t/keploy/shared_invite/zt-12rfbvc01-o54cOG0X1G6eVJTuI_orSA) - Discussions with the community and the team.
* [GitHub](https://github.com/keploy/keploy/issues) - For bug reports and feature requests.

