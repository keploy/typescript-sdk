/* eslint-disable @typescript-eslint/no-explicit-any */
import { log } from "console";
import { Request, Response, NextFunction } from "express";
const fs = require('fs');
const yaml = require('js-yaml');

const filePath = 'dedupData.yaml';


// middleware
export default function middleware(

): (req: Request, res: Response, next: NextFunction) => void {
  console.log("Inside middleware...");

  // @ts-ignore
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      // Create the file if it doesn't exist
      fs.writeFileSync(filePath, '', 'utf-8');
    }
  });
  return (req: Request, res: Response, next: NextFunction) => {
    res.on("finish", () => {

      afterMiddleware(req, res);
    });
    next();

  };
}


export function afterMiddleware(req: Request, res: Response) {
  let id = req.get("KEPLOY-TEST-ID");
  if (!id) {
    console.error("No test ID found in the request headers");
    return;
  }
  let executedLinesByFile = GetCoverage();

  let currentData = {
    id: id,
    executedLinesByFile: executedLinesByFile
  };


  let existingData = [];

  try {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    existingData = yaml.load(fileContent) || [];
  } catch (error) {
    // Handle the case where the file doesn't exist or is not valid YAML
    console.error("Error reading existing file:", error);
  }


  if (!Array.isArray(existingData)) {
    console.error('Expected an array for existingData, but got:', typeof existingData);
    existingData = []; // Reset to an empty array or handle accordingly
  }

  // Add or update the entry for the current id
  existingData.push(currentData);

  // Convert the array to YAML format
  const yamlData = yaml.dump(existingData);

  // Write the updated YAML data back to the file
  fs.writeFileSync(filePath, yamlData, 'utf-8');

  // Log to the console
  console.log("Executed lines by file:", executedLinesByFile);
  console.log("Data has been appended and logged to", filePath);
}

// isJsonValid checks whether o is a valid JSON or not

let count = 0;
const executedLinebyEachTest = new Array();
function GetCoverage() {
  console.log("Inside GetCoverage");
  count++;
  let executedLinesByFile = {};
  // iterate over global.__coverage__
  // @ts-ignore
  for (const filename in global.__coverage__) {
    // console.log("FIlenamae", filename);
    // while (1) {
    // @ts-ignore
    let coverageData = global.__coverage__[filename];
    // console.log("Inside GetCoverage " + count);
    // console.log(coverageData);


    // for (const filePath of Object.keys(coverageData)) {
    const executedLines = new Set();
    const fileCoverage = coverageData;
    const statementMap = fileCoverage.statementMap;
    const hitCounts = fileCoverage.s;
    if (count > 1) {
      // iterate over hitcounts and subtract the previous hitcounts
      // @ts-ignore
      var prevHitCounts = executedLinebyEachTest[count - 2];

      for (const statementId in hitCounts) {
        hitCounts[statementId] = Math.abs(
          hitCounts[statementId] - prevHitCounts[statementId]
        );
      }
    }

    for (const statementId in statementMap) {
      if (hitCounts[statementId] > 0) {
        const executedLine = statementMap[statementId].start.line;
        executedLines.add(executedLine);
      }
    }
    // @ts-ignore
    executedLinesByFile[filename] = Array.from(executedLines).sort((a, b) => a - b);
    // }
    // @ts-ignore
    executedLinebyEachTest.push({ ...hitCounts });

    console.log("Executed lines by file:", executedLinesByFile);
    // extract s from the coverage data
  }
  return executedLinesByFile;
}
