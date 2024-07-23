/* eslint-disable @typescript-eslint/no-explicit-any */
import { log } from "console";
import { Request, Response, NextFunction } from "express";
const fs = require('fs');
const yaml = require('js-yaml');

const filePath = 'dedupData.yaml';

// middleware
export default function middleware(): (req: Request, res: Response, next: NextFunction) => void {
  // console.log("Inside middleware...");

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
  let testSet = req.get("KEPLOY-TEST-SET-ID");
  if (!id) {
    console.error("No test ID found in the request headers");
    return;
  }
  let executedLinesByFile = GetCoverage();

  let currentData = {
    id: testSet + "/" + id,
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
  // console.log("Executed lines by file:", executedLinesByFile);
  // console.log("Data has been appended and logged to", filePath);
}

let count = 0;
type HitCounts = { [statementId: string]: number };
type CoverageData = { [filename: string]: { statementMap: any, s: HitCounts } };
type ExecutedLineByEachTest = { [filename: string]: HitCounts }[];

const executedLinebyEachTest: ExecutedLineByEachTest = [];
const executedLinesByFile: { [filename: string]: number[] } = {};

declare const global: { __coverage__: CoverageData };

function GetCoverage() {
    count++;

    for (const filename in global.__coverage__) {
        let coverageData = global.__coverage__[filename];
        const executedLines = new Set<number>();
        const fileCoverage = coverageData;
        const statementMap = fileCoverage.statementMap;
        const hitCounts = fileCoverage.s;
        // console.log("hitcounts", hitCounts);

        if (count > 1) {
            if (!executedLinebyEachTest[count - 2]) {
                executedLinebyEachTest[count - 2] = {};
            }
            const prevHitCounts = executedLinebyEachTest[count - 2][filename] || {};
            for (const statementId in hitCounts) {
                const currentHitCount = isNaN(hitCounts[statementId]) ? 0 : hitCounts[statementId];
                const previousHitCount = isNaN(prevHitCounts[statementId]) ? 0 : prevHitCounts[statementId];
                hitCounts[statementId] = Math.abs(currentHitCount - previousHitCount);
            }
        }

        for (const statementId in statementMap) {
            if (hitCounts[statementId] > 0) {
                const executedLine = statementMap[statementId].start.line;
                // console.log("executedLine", executedLine);
                executedLines.add(executedLine);
            }
        }

        executedLinesByFile[filename] = Array.from(executedLines).sort((a, b) => a - b);

        if (!executedLinebyEachTest[count - 1]) {
            executedLinebyEachTest[count - 1] = {};
        }

        executedLinebyEachTest[count - 1][filename] = { ...hitCounts };

        // console.log("Executed lines by file executedLinebyEachTest:", executedLinebyEachTest);
    }
    return executedLinesByFile;
}

module.exports = middleware;