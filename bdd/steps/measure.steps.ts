import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import { ask, createThread, latestAnswerRecord, type AnswerRecord } from '../support/api.ts';
import { requireSettings, settings } from '../support/env.ts';
import { numberedImage, randomNumbers, toInput } from '../support/images.ts';
import { addRow, fmt, median } from '../support/report.ts';
import type { ImageWorld } from '../support/world.ts';

/** Megabits per second for a few typical connections, for the upload estimate. */
const CONNECTIONS = [
  { name: 'slow 3G-like (1 Mbps up)', mbps: 1 },
  { name: 'typical 4G (5 Mbps up)', mbps: 5 },
  { name: 'home Wi-Fi (20 Mbps up)', mbps: 20 },
];

function prices(): { input: number; output: number } | null {
  const input = Number(settings.value('GEMINI_INPUT_USD_PER_MTOK'));
  const output = Number(settings.value('GEMINI_OUTPUT_USD_PER_MTOK'));
  return input > 0 && output > 0 ? { input, output } : null;
}

function costOf(r: AnswerRecord, p: { input: number; output: number }): number {
  // Thinking tokens are billed at the output rate.
  return (r.inputTokens * p.input + (r.outputTokens + r.thinkingTokens) * p.output) / 1_000_000;
}

When(
  /^I ask "(.*)" with (\d+) photo-sized images, (\d+) times$/,
  async function (this: ImageWorld, question: string, imageCount: string, times: string) {
    const feature = this.feature.startsWith('Cost') ? 'cost' : 'latency';
    const p = prices();
    this.runs = [];
    for (let i = 0; i < Number(times); i++) {
      // A fresh thread per run: earlier turns in the history would add cost and time.
      const threadId = await createThread(this.baseUrl, this.token);
      const numbers = randomNumbers(Number(imageCount));
      const images = await Promise.all(numbers.map(async (n) => toInput(await numberedImage(n))));
      const result = await ask(this.baseUrl, this.token, threadId, question, images);
      assert.equal(result.error, null, `run ${i + 1} failed (status ${result.status}): ${result.error}`);
      const record = await latestAnswerRecord(threadId);
      this.runs.push({ threadId, images: images.length, result, record });

      addRow(
        'Measured answers',
        ['Feature', 'Images', 'Run', 'Model', 'Input tok', 'Output tok', 'Thinking tok', 'Cost', 'First word', 'Full answer', 'Upload'],
        [
          feature,
          images.length,
          i + 1,
          record?.modelId ?? '?',
          record?.inputTokens ?? '?',
          record?.outputTokens ?? '?',
          record?.thinkingTokens ?? '?',
          record && p ? fmt.usd(costOf(record, p)) : 'set prices',
          fmt.sec(result.firstWordMs),
          fmt.sec(result.totalMs),
          fmt.mb(result.uploadBytes),
        ],
        'Each run is a fresh thread. Tokens are what the server recorded for the whole answer (all model calls).'
      );
    }
  }
);

Then('the median cost of one answer is at most ${float}', function (this: ImageWorld, max: number) {
  requireSettings(['GEMINI_INPUT_USD_PER_MTOK', 'GEMINI_OUTPUT_USD_PER_MTOK'], 'cost');
  const p = prices()!;
  const costs = this.runs.map((r) => {
    assert.ok(r.record, `no answer was recorded for thread ${r.threadId}`);
    return costOf(r.record, p);
  });
  const m = median(costs);
  addRow('Cost summary', ['Images', 'Median cost', 'Limit', 'Runs'], [this.runs[0].images, fmt.usd(m), fmt.usd(max), costs.map(fmt.usd).join(', ')]);
  assert.ok(m <= max, `median cost ${fmt.usd(m)} is over the ${fmt.usd(max)} limit`);
});

Then('the median time to the first word is at most {float} seconds', function (this: ImageWorld, max: number) {
  const times = this.runs.map((r) => r.result.firstWordMs ?? Infinity);
  const m = median(times);
  const total = median(this.runs.map((r) => r.result.totalMs));
  const upload = Math.max(...this.runs.map((r) => r.result.uploadBytes));
  addRow(
    'Latency summary',
    ['Images', 'Median first word', 'Median full answer', 'Upload', ...CONNECTIONS.map((c) => `Upload time, ${c.name}`)],
    [
      this.runs[0].images,
      fmt.sec(m),
      fmt.sec(total),
      fmt.mb(upload),
      ...CONNECTIONS.map((c) => fmt.sec(((upload * 8) / (c.mbps * 1_000_000)) * 1000)),
    ],
    'Measured on this machine against the real model. Upload times are computed from the body size, not measured; on a phone they add to "first word".'
  );
  assert.ok(m <= max * 1000, `median time to the first word is ${fmt.sec(m)}, over ${max}s`);
});

Then('the median time to the full answer is at most {float} seconds', function (this: ImageWorld, max: number) {
  const m = median(this.runs.map((r) => r.result.totalMs));
  assert.ok(m <= max * 1000, `median time to the full answer is ${fmt.sec(m)}, over ${max}s`);
});

Then('the upload is at most {float} MB', function (this: ImageWorld, max: number) {
  const upload = Math.max(...this.runs.map((r) => r.result.uploadBytes));
  assert.ok(upload <= max * 1024 * 1024, `the request body is ${fmt.mb(upload)}, over ${max} MB`);
});
