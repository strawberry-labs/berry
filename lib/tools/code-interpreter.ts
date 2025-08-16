import { tool } from 'ai';
import { z } from 'zod';
import { Daytona } from '@daytonaio/sdk';
import { serverEnv } from '@/env/server';
import { SNAPSHOT_NAME } from '@/lib/constants';

export const codeInterpreterTool = tool({
  description: 'Write and execute Python code.',
  inputSchema: z.object({
    title: z.string().describe('The title of the code snippet.'),
    code: z
      .string()
      .describe(
        'The Python code to execute. put the variables in the end of the code to print them. do not use the print function.',
      ),
    icon: z.enum(['stock', 'date', 'calculation', 'default']).describe('The icon to display for the code snippet.'),
  }),
  execute: async ({ code, title, icon }) => {
    const daytona = new Daytona({
      apiKey: serverEnv.DAYTONA_API_KEY,
      target: 'us',
    });

    const sandbox = await daytona.create({
      snapshot: SNAPSHOT_NAME,
    });

    const execution = await sandbox.process.codeRun(code);

    let message = '';

    if (execution.artifacts?.stdout === execution.result) {
      message += execution.result;
    } else if (execution.result && execution.result !== execution.artifacts?.stdout) {
      message += execution.result;
    } else if (execution.artifacts?.stdout && execution.artifacts?.stdout !== execution.result) {
      message += execution.artifacts.stdout;
    } else {
      message += execution.result;
    }

    let chart;
    if (execution.artifacts?.charts) {
      // Charts available
    }

    if (execution.artifacts?.charts) {
      chart = execution.artifacts.charts[0];
    }

    const chartData = chart
      ? {
          type: chart.type,
          title: chart.title,
          elements: chart.elements,
          png: undefined,
        }
      : undefined;

    await sandbox.delete();

    return {
      message: message.trim(),
      chart: chartData,
    };
  },
});