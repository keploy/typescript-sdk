[![contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen?logo=github)](CODE_OF_CONDUCT.md)
[![Slack](.github/slack.svg)](https://join.slack.com/t/keploy/shared_invite/zt-12rfbvc01-o54cOG0X1G6eVJTuI_orSA)
[![License](.github/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

# Keploy Typescript-SDK
[Keploy](https://keploy.io) is a no-code testing platform that generates tests from API calls. This is the Typescript client SDK for recording and replaying the API Calls. There are 2 modes:
1. **Record mode**
    1. Records the requests/response of API call and generates the corresponding testcase.
    2. Simulates the same request payload to the API for identifying the noisy fields in response.
2. **Test mode**
    1. Fetches the recorded testcases of the application from Keploy.
    2. Calls the API with same request payload in testcase.
    3. Validates the respones and uploads results to the Keploy server.
3. **Off mode**
    - Turns off the functionality of keploy testing framework. It is the default mode

## Contents
1. [Installation](#installation)
2. [Configure](#configure)
3. [Usage](#usage)
4. [Supported Routers](#supported-routers)
5. [Supported Dependencies](#supported-dependencies)
6. [Mocking/Stubbing for unit tests](#mockingstubbing-for-unit-tests)
7. [Test with code coverage](#test-with-code-coverage)
8. [Development Setup](#development-setup)
9. [Community support](#community-support)

## Installation
```bash
npm i https://github.com/keploy/typescript-sdk
```

## Configure
SDK uses environment variables for configuration. If not provided, then SDK uses default values. 

**Note**: "KEPLOY_APP_PORT" is required else, it will throw error on "record"/"test" mode.
``` bash
export KEPLOY_MODE="off"           # Values: "record" / "test" / "off"(default) 
export KEPLOY_APP_NAME="my-app"    # [app_ids] for different API applications. Default: "sample-app"
export KEPLOY_APP_HOST="localhost" # Host of API application. Default: "localhost"
export KEPLOY_APP_PORT=XXXX        # port on which API is running. Required
export KEPLOY_APP_DELAY=5          # approx time taken by API server to start. Default: 5sec
export KEPLOY_APP_TIMEOUT=100      # request timeout for keploy server. Default: 60sec
# export KEPLOY_APP_FILTER={"urlRegex":"*"}  # filters for capturing tcs. It should be a valid JSON

export KEPLOY_SERVER_URL="localhost:6789" # url to running keploy server. Default: "localhost:6789"
# export KEPLOY_SERVER_LICENSE="XXX-XXX-XXX" # hosted keploy server api key
```

## Supported Routers
### 1. Express
Add the following require statement before the require statement of express.
```js
require("typescript-sdk/dist/integrations/express/register");
```

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
Note:- Currently not supported for ES module. You can use require statements in esmodule by:
```js
// Define "require"
import { createRequire } from "module";
const require = createRequire(import.meta.url);
```

## Supported Dependencies
### 1. Octokit
To integrate just add this line before require statement of Octokit in your application.
```js
require("typescript-sdk/dist/integrations/octokit/require")
```

### 2. Mongoose
To integrate just add this line before require statement of mongoose in your application.
```js
require("typescript-sdk/dist/integrations/mongoose/require")
```
Currently, keploy mocks/stubs outputs for:
1. find()
2. findOne()
3. save()
4. create()
5. insertMany()
6. updateOne()
7. updateMany()
8. deleteOne()
9. deleteMany()

### **Note**: 
Since, this package uses require-in-the-middle for adding hook. Therefore, it is supported for commonjs module currently. Also, you can use require statements in esmodule by:
```js
// Define "require"
import { createRequire } from "module";
const require = createRequire(import.meta.url);
```

## Mocking/Stubbing for unit tests
These mocks/stubs are realistic and frees you up from writing them manually. Keploy creates `readable/editable` mocks/stubs yaml files which can be referenced in any of your unit-tests tests. Steps to mock/stub external calls:

1. **Wrap the dependencies**: 
   1. Call mock.NewContext with tcsName and mode in test setup for each testcase. 
   2. Integrate the supported dependecies in your unit-tests.
2. **Record**: 
   1. Set the mode in NewContext to "record" 
   2. Run the unit test. 
   
   Now, a mocks directory containing yaml files for each testcase in unit test. The yaml files have docs for recorded outputs of integrated deps call.
3. **Test**: 
   1. Set the mode in NewContext to "test" 
   2. Turn off the dependency server or DB.
   3. Run the unit test. 
   And the unit test will run perfectly using the recorded outputs from yaml files in generated mocks directory.

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

**Note**: Since, this package uses require-in-the-middle for adding hook. Therefore, it is supported for commonjs module currently. Also, you can use require statements in esmodule by:
```js
// Define "require"
import { createRequire } from "module";
const require = createRequire(import.meta.url);
```

## Test with code coverage
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

## Community support
We'd love to collaborate with you to make Keploy great. To get started:
* [Slack](https://join.slack.com/t/keploy/shared_invite/zt-12rfbvc01-o54cOG0X1G6eVJTuI_orSA) - Discussions with the community and the team.
* [GitHub](https://github.com/keploy/keploy/issues) - For bug reports and feature requests.

