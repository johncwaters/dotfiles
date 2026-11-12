import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workflowFunctionNamed } from './qa-swarm-source.mjs'

const parseLaneResponse = workflowFunctionNamed('parseLaneResponse')
const findConvergenceValidationFailure = workflowFunctionNamed('findConvergenceValidationFailure')
const withJudgmentRowsFolded = workflowFunctionNamed('withJudgmentRowsFolded')

const firstFindingRow = '- file: src/first.js | line: 8 | side: RIGHT | severity: HIGH | reviewer: code/logic | body: First finding.'
const secondFindingRow = '- file: src/second.js | line: general | severity: MEDIUM | reviewer: security/auth | body: Second finding.'

function responseWith(findingsBlock, summary = 'Lane summary.') {
  return `STRUCTURED_FINDINGS:\n${findingsBlock}\n\nOVERALL_SUMMARY:\n${summary}`
}

function findingRowBlockOf(findingCount) {
  return Array.from({ length: findingCount }, (unusedValue, findingIndex) => `- file: src/file${findingIndex}.js | line: ${findingIndex + 1} | side: RIGHT | severity: MEDIUM | reviewer: code/logic | body: Finding ${findingIndex}.`).join('\n')
}

function assertLiveWithoutFindings(parsedResponse) {
  assert.equal(parsedResponse.hasParseableBlock, true)
  assert.equal(parsedResponse.hasUnparseableRow, false)
  assert.deepEqual(parsedResponse.findings, [])
}

function assertDead(parsedResponse) {
  assert.equal(parsedResponse.hasParseableBlock, false)
  assert.deepEqual(parsedResponse.findings, [])
}

test('trailing none text on the findings header parses as the first block line', () => {
  const parsedResponse = parseLaneResponse('STRUCTURED_FINDINGS: (none)\n\nOVERALL_SUMMARY:\nNo findings.')

  assertLiveWithoutFindings(parsedResponse)
})

test('every inline none synonym on the header line parses live with zero findings', () => {
  for (const inlineNone of ['(none)', '(no findings)', '(nothing)', '(empty)', '(none found)', '[]', 'none', 'NONE', '- (none)']) {
    const parsedResponse = parseLaneResponse(`STRUCTURED_FINDINGS: ${inlineNone}\n\nOVERALL_SUMMARY:\nNo findings.`)

    assertLiveWithoutFindings(parsedResponse)
  }
})

test('an inline finding row on the header line parses as that finding', () => {
  const parsedResponse = parseLaneResponse(`STRUCTURED_FINDINGS: ${firstFindingRow}\n\nOVERALL_SUMMARY:\nOne finding.`)

  assert.equal(parsedResponse.hasParseableBlock, true)
  assert.equal(parsedResponse.hasUnparseableRow, false)
  assert.equal(parsedResponse.findings.length, 1)
  assert.equal(parsedResponse.findings[0].fields.file, 'src/first.js')
})

test('bulleted none forms parse as live lanes with zero findings', () => {
  for (const bulletedNone of ['- (none)', '* (none)']) {
    const parsedResponse = parseLaneResponse(responseWith(bulletedNone))

    assertLiveWithoutFindings(parsedResponse)
  }
})

test('a narrative mention of the findings header is not a header, so the real block below it still parses', () => {
  const parsedResponse = parseLaneResponse(`STRUCTURED_FINDINGS: I will list them below.\n\n${responseWith(firstFindingRow)}`)

  assert.equal(parsedResponse.hasParseableBlock, true)
  assert.equal(parsedResponse.hasUnparseableRow, false)
  assert.equal(parsedResponse.findings.length, 1)
  assert.equal(parsedResponse.findings[0].raw, firstFindingRow)
})

test('a narrative mention of the findings header with no real block anywhere stays dead', () => {
  const parsedResponse = parseLaneResponse('STRUCTURED_FINDINGS: I will list them below.\n\nOVERALL_SUMMARY:\nNothing worth reporting.')

  assertDead(parsedResponse)
})

test('a header line saying only a none synonym is read as an empty block because that line can mean nothing else', () => {
  const parsedResponse = parseLaneResponse('The lane reported this.\nSTRUCTURED_FINDINGS: (none)\n\nOVERALL_SUMMARY:\nNothing worth reporting.')

  assertLiveWithoutFindings(parsedResponse)
})

test('an empty block between the two headers is dead rather than an implied none', () => {
  const parsedResponse = parseLaneResponse(responseWith(''))

  assertDead(parsedResponse)
})

test('a block of unparseable prose is dead and reports the unparseable row', () => {
  const parsedResponse = parseLaneResponse(responseWith('The SQL injection in a.js line 3 is exploitable.'))

  assertDead(parsedResponse)
  assert.equal(parsedResponse.hasUnparseableRow, true)
})

test('a block mixing parsed rows with one malformed row keeps the parsed findings and still reports the malformed row', () => {
  const parsedResponse = parseLaneResponse(responseWith([
    firstFindingRow,
    secondFindingRow,
    '- file: src/third.js | line: 3 | side: RIGHT | severity: CRIT | reviewer: code/logic | body: Malformed severity.'
  ].join('\n')))

  assert.equal(parsedResponse.hasParseableBlock, true)
  assert.equal(parsedResponse.hasUnparseableRow, true)
  assert.deepEqual(parsedResponse.findings.map((parsedFinding) => parsedFinding.raw), [firstFindingRow, secondFindingRow])
})

test('rows the orchestration filters out later still parse into a live lane', () => {
  const parsedResponse = parseLaneResponse(responseWith('- file: src/first.js | line: 8 | side: RIGHT | severity: LOW | reviewer: docs/style | body: Filtered downstream.'))

  assert.equal(parsedResponse.hasParseableBlock, true)
  assert.equal(parsedResponse.hasUnparseableRow, false)
  assert.equal(parsedResponse.findings.length, 1)
  assert.equal(parsedResponse.findings[0].fields.severity, 'LOW')
})

test('an empty summary body stays dead because that is the shape of output truncated at the header', () => {
  const parsedResponse = parseLaneResponse(responseWith('(none)', ''))

  assertDead(parsedResponse)
})

test('a findings block with no summary header at all stays dead because nothing pins the output as untruncated', () => {
  const parsedResponse = parseLaneResponse(`STRUCTURED_FINDINGS:\n${firstFindingRow}\n`)

  assertDead(parsedResponse)
})

test('a normal multi-finding block keeps its parsed representation', () => {
  const parsedResponse = parseLaneResponse(responseWith([firstFindingRow, secondFindingRow].join('\n')))

  assert.deepEqual(parsedResponse, {
    hasParseableBlock: true,
    hasUnparseableRow: false,
    findings: [
      {
        raw: firstFindingRow,
        fields: {
          body: 'First finding.',
          file: 'src/first.js',
          line: '8',
          side: 'RIGHT',
          severity: 'HIGH',
          reviewer: 'code/logic'
        }
      },
      {
        raw: secondFindingRow,
        fields: {
          body: 'Second finding.',
          file: 'src/second.js',
          line: 'general',
          severity: 'MEDIUM',
          reviewer: 'security/auth'
        }
      }
    ],
    summary: 'Lane summary.',
    hitFindingCap: false
  })
})

test('output without a findings block remains dead', () => {
  const parsedResponse = parseLaneResponse('OVERALL_SUMMARY:\nNo findings block.')

  assertDead(parsedResponse)
})

test('a quoted format echo carrying an inline none header leaves the real block below it live', () => {
  const parsedResponse = parseLaneResponse(`Format:\nSTRUCTURED_FINDINGS: (none)\n\nActual:\n${responseWith(firstFindingRow)}`)

  assert.equal(parsedResponse.hasParseableBlock, true)
  assert.equal(parsedResponse.hasUnparseableRow, false)
  assert.deepEqual(parsedResponse.findings.map((parsedFinding) => parsedFinding.raw), [firstFindingRow])
})

test('a fenced format echo carrying an inline none header leaves the real block below it live', () => {
  const parsedResponse = parseLaneResponse(`Format:\n\`\`\`\nSTRUCTURED_FINDINGS: (none)\n\`\`\`\n\nActual:\n${responseWith(firstFindingRow)}`)

  assert.equal(parsedResponse.hasParseableBlock, true)
  assert.equal(parsedResponse.hasUnparseableRow, false)
  assert.deepEqual(parsedResponse.findings.map((parsedFinding) => parsedFinding.raw), [firstFindingRow])
})

test('a header-shaped line inside the summary body leaves the real block above it live', () => {
  for (const summaryTail of ['STRUCTURED_FINDINGS: none', 'STRUCTURED_FINDINGS: file: src/first.js is the only file.']) {
    const parsedResponse = parseLaneResponse(responseWith(firstFindingRow, `Lane summary.\n${summaryTail}`))

    assert.equal(parsedResponse.hasParseableBlock, true)
    assert.equal(parsedResponse.hasUnparseableRow, false)
    assert.deepEqual(parsedResponse.findings.map((parsedFinding) => parsedFinding.raw), [firstFindingRow])
  }
})

test('two bare findings headers stay dead because nothing picks between them', () => {
  const parsedResponse = parseLaneResponse(`STRUCTURED_FINDINGS:\n${firstFindingRow}\n\nSTRUCTURED_FINDINGS:\n${secondFindingRow}\n\nOVERALL_SUMMARY:\nLane summary.`)

  assertDead(parsedResponse)
})

test('a lane that repeats its whole block and summary with the same findings reworded parses as the last block', () => {
  const rewordedFirstRow = firstFindingRow.replace('First finding.', 'First finding, reworded.')
  const parsedResponse = parseLaneResponse(`Lead-in prose.\n\n${responseWith(firstFindingRow, 'First summary.')}\n\n${responseWith(rewordedFirstRow, 'Last summary.')}`)

  assert.equal(parsedResponse.hasParseableBlock, true)
  assert.equal(parsedResponse.hasUnparseableRow, false)
  assert.deepEqual(parsedResponse.findings.map((parsedFinding) => parsedFinding.raw), [rewordedFirstRow])
  assert.equal(parsedResponse.summary, 'Last summary.')
})

test('a lane that repeats a none block and summary stays live with zero findings', () => {
  const parsedResponse = parseLaneResponse(`${responseWith('(none)')}\n\n${responseWith('(none)')}`)

  assertLiveWithoutFindings(parsedResponse)
})

test('repeated blocks reporting different findings stay dead because nothing picks between them', () => {
  const parsedResponse = parseLaneResponse(`${responseWith(firstFindingRow)}\n\n${responseWith(secondFindingRow)}`)

  assertDead(parsedResponse)
})

test('repeated blocks that differ only past the per-lane finding cap stay dead', () => {
  const highFindingRows = Array.from({ length: 10 }, (unusedValue, findingIndex) => `- file: src/high${findingIndex}.js | line: ${findingIndex + 1} | side: RIGHT | severity: HIGH | reviewer: code/logic | body: High ${findingIndex}.`).join('\n')
  const mediumRowAtLine = (lineNumber) => `- file: src/medium.js | line: ${lineNumber} | side: RIGHT | severity: MEDIUM | reviewer: code/logic | body: Medium.`
  const parsedResponse = parseLaneResponse(`${responseWith(`${highFindingRows}\n${mediumRowAtLine(55)}`)}\n\n${responseWith(`${highFindingRows}\n${mediumRowAtLine(77)}`)}`)

  assertDead(parsedResponse)
})

test('repeated blocks where one carries a malformed row stay dead', () => {
  const parsedResponse = parseLaneResponse(`${responseWith(firstFindingRow)}\n\n${responseWith(`${firstFindingRow}\nnot a finding row`)}`)

  assertDead(parsedResponse)
})

test('two tailed findings headers with no bare header stay dead because nothing picks between them', () => {
  const parsedResponse = parseLaneResponse(`STRUCTURED_FINDINGS: (none)\n\nSTRUCTURED_FINDINGS: ${firstFindingRow}\n\nOVERALL_SUMMARY:\nLane summary.`)

  assertDead(parsedResponse)
})

test('a single tailed findings header with no bare header stays live', () => {
  const parsedResponse = parseLaneResponse(`STRUCTURED_FINDINGS: ${firstFindingRow}\n\nOVERALL_SUMMARY:\nLane summary.`)

  assert.equal(parsedResponse.hasParseableBlock, true)
  assert.equal(parsedResponse.hasUnparseableRow, false)
  assert.deepEqual(parsedResponse.findings.map((parsedFinding) => parsedFinding.raw), [firstFindingRow])
})

test('decorated headers remain parseable', () => {
  const parsedResponse = parseLaneResponse('**STRUCTURED_FINDINGS:**\n(none)\n\n## OVERALL_SUMMARY:\nNo findings.')

  assertLiveWithoutFindings(parsedResponse)
})

test('a block holding exactly the ten-finding cap counts as capped because the lane may have dropped more', () => {
  const parsedResponse = parseLaneResponse(responseWith(findingRowBlockOf(10), 'Ten findings and not a word about overflow.'))

  assert.equal(parsedResponse.findings.length, 10)
  assert.equal(parsedResponse.hitFindingCap, true)
})

test('a block one finding below the cap is not capped', () => {
  const parsedResponse = parseLaneResponse(responseWith(findingRowBlockOf(9), 'Nine findings and not a word about overflow.'))

  assert.equal(parsedResponse.findings.length, 9)
  assert.equal(parsedResponse.hitFindingCap, false)
})

test('a converged finding whose merged body wraps onto continuation lines validates as one finding after folding', () => {
  const wrappedJudgment = [
    'STRUCTURED_FINDINGS:',
    '- file: src/first.js | line: 86 | side: RIGHT | severity: MEDIUM | reviewer: convergent: code/migration + redteam/signal | body: Two upgrade cases break:',
    '- Released builds verified children through an old id.',
    '',
    'code/migration Proof: a scratch script printed verifierIntentIds: [].',
    '',
    'OVERALL_SUMMARY:',
    '1 finding(s) survived. truncated lanes: none'
  ].join('\n')
  const reviewedFiles = new Set(['src/first.js'])

  assert.equal(findConvergenceValidationFailure(wrappedJudgment, [], reviewedFiles), 'an unparseable row')
  assert.equal(findConvergenceValidationFailure(withJudgmentRowsFolded(wrappedJudgment), [], reviewedFiles), null)
  assert.match(parseLaneResponse(withJudgmentRowsFolded(wrappedJudgment)).findings[0].fields.body, /^Two upgrade cases break: - Released builds verified children through an old id\. code\/migration Proof: a scratch script printed verifierIntentIds: \[\]\.$/)
})

test('a judgment finding tagged both convergent and contested validates', () => {
  const combinedTagJudgment = responseWith(
    '- file: session/sessions.ts | line: 1654 | side: RIGHT | severity: HIGH | reviewer: convergent: redteam/coverage + boundary/key-collision; contested: redteam vs code | body: A child spawn clears the parent pack skills. Proof: a scratch node:test printed conflicts: skills-agent-made.1. Confidence: low, tiebreak unavailable.',
    '1 finding(s) survived. truncated lanes: none'
  )

  assert.equal(findConvergenceValidationFailure(combinedTagJudgment, [], new Set(['session/sessions.ts'])), null)
})
