/* eslint-disable @typescript-eslint/no-explicit-any */
import { log } from "console";
import { Request, Response, NextFunction } from "express";
const fs = require('fs');
import { entryYaml } from "./entry";

const filePath = 'dedupData.yaml';

// middleware
export default function middleware(): (req: Request, res: Response, next: NextFunction) => void {
  // console.log("Inside middleware...");

  // Create the file if it does not exist, now, with an append of nothing,
  // which never empties it; a file that exists is not written. Checking for
  // it asynchronously and then writing it empty, as before, dropped the
  // entries of requests that finished between the check and its callback.
  if (!fs.existsSync(filePath)) fs.appendFileSync(filePath, '', 'utf-8');
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

  // The file is a list that only grows: append this request's entry, as
  // js-yaml 4 wrote it, rather than read, parse and rewrite the whole file,
  // which cost each request time and memory in proportion to the file.
  fs.appendFileSync(filePath, entryYaml(testSet + "/" + id, executedLinesByFile), 'utf-8');

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