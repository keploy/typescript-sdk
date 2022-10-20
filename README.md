[![contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen?logo=github)](CODE_OF_CONDUCT.md)
[![Slack](.github/slack.svg)](https://join.slack.com/t/keploy/shared_invite/zt-12rfbvc01-o54cOG0X1G6eVJTuI_orSA)
[![License](.github/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

# Keploy Typescript-SDK
[Keploy](https://keploy.io) is a no-code testing platform that generates tests from API calls. This is the Typescript client SDK for recording and replaying the API Calls. There are 2 modes:
1. **Record mode**
    1. Record requests, response and sends to Keploy server.
    2. After keploy server removes duplicates, it then runs the request on the API again to identify noisy fields.
    3. Sends the noisy fields to the keploy server to be saved along with the testcase.
2. **Test mode**
    1. Fetches testcases for the app from keploy server.
    2. Calls the API with same request payload in testcase.
    3. Validates the respones and uploads results to the keploy server.

## Contents
1. [Installation](#installation)
2. [Usage](#usage)
3. [Configure](#configure)
4. [Supported Frameworks](#supported-frameworks)

## Installation
```bash
npm i https://github.com/keploy/typescript-sdk
```

## Usage

```js
require("typescript-sdk/dist/integrations/express/register");
```
The require statement should be at the top of your main file (server.js). 

Example :
```js
require("typescript-sdk/dist/integrations/express/register");
var express = require('express');
var app = express();
app.get('/', function (req, res) {
    res.send('Hello World!\n');
});

var server = app.listen(3000,() =>
console.log(`Example app listening on port 3000!`));
module.exports = server;
```

## Configure
```
export KEPLOY_MODE="test"
export KEPLOY_APP_NAME="my-app"
export KEPLOY_APP_HOST="localhost"
export KEPLOY_APP_PORT=5050 # port on which server is running
export KEPLOY_APP_DELAY=5 # time delay before starting testruns(in seconds)
export KEPLOY_APP_TIMEOUT=100 # should be number 
# export KEPLOY_APP_FILTER={"urlRegex":"*"}  # should be json not to capture for certain url's

export KEPLOY_SERVER_URL="http://localhost:6789/api" # self hosted keploy running server
# export KEPLOY_SERVER_LICENSE="XXX-XXX-XXX" # hosted keploy server api key
```
### KEPLOY_MODE
There are 3 modes:
 - **Record**: Sets to record mode.
 - **Test**: Sets to test mode.
 - **Off**: Turns off all the functionality provided by the API

**Note:** `KEPLOY_MODE` value is case sensitive.

## Generate E2E tests (with mocks)

```
export KEPLOY_TEST_CASE_PATH="./example"    # If KEPLOY_TEST_CASE_PATH is not provided then a folder named keploy-tests will be made containing mocks folder. If KEPLOY_MOCK_PATH is provided then the mocks will be generated there. 
export KEPLOY_MOCK_PATH="./exampleMockPath"
```

**Note:** To enable `Test Export`, add `export ENABLE_TEST_EXPORT=true` in your .env file of [keploy-server](https://github.com/keploy/keploy) repository. If enabled, yaml files  containing test cases will be generated in the directory provided by the user. Similarly, mocks will be generated in the yaml files.

## Supported Routers
### 1. Express
```js
require("typescript-sdk/dist/integrations/express/register");
```
The require statement should be at the top of your main file (server.js).

#### Example
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
Note:- Import statements can't be used. Use require instead of import.

## Supported Dependencies

### 1. Octokit

```js
require("typescript-sdk/dist/integrations/octokit/require")
```
This statement should be at the top of your main file (server.js).

Note:- Import statements can't be used. Only CommonJs support is currently provided.
## Development Setup

- This project uses [Yarn](https://yarnpkg.com/) for package management. To install yarn, please make sure [Node](https://nodejs.org/en/) is installed and then:

```sh
npm i -g yarn
```

- To install local dependencies, assuming you are at root of the project:

```sh
yarn install
```

### How to use mock library

The external calls from unit tests will be recorded and replayed as mocks from yaml files under a directory named mocks.

Following is an example of unit test with octokit :

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
Above example test is written in commonjs module. 

**Note**: Since, this package uses require-in-the-middle for adding hook. Therefore, it is supported for commonjs module currently. Also, you can use require statements in esmodule by:
```js
// Define "require"
import { createRequire } from "module";
const require = createRequire(import.meta.url);
```

### Integration with Mocha testing framework
You just need to do some imports and call a built-in assert function in your code in your unit test file and that's it!!🔥🔥🔥
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
Note:- To see code coverage please use nyc mocha and see how many lines are covered!!

Note:- Jest is not supported currently!!


- Furthermore, to commit your changes use `yarn commit` instead of `git commit` for better commit experience.

- For VSCode setup, make sure these extensions are installed:
  - [EditorConfig](https://marketplace.visualstudio.com/items?itemName=EditorConfig.EditorConfig)
  - [Eslint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)

## Community support
We'd love to collaborate with you to make Keploy great. To get started:
* [Slack](https://join.slack.com/t/keploy/shared_invite/zt-12rfbvc01-o54cOG0X1G6eVJTuI_orSA) - Discussions with the community and the team.
* [GitHub](https://github.com/keploy/keploy/issues) - For bug reports and feature requests.

