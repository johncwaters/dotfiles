import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workflowFunctionNamed } from './qa-swarm-source.mjs'

const parseLaneResponse = workflowFunctionNamed('parseLaneResponse')

const firstFindingRow = '- file: src/first.js | line: 8 | side: RIGHT | severity: HIGH | reviewer: code/logic | body: First finding.'
const secondFindingRow = '- file: src/second.js | line: general | severity: MEDIUM | reviewer: security/auth | body: Second finding.'

function responseWith(findingsBlock, summary = 'Lane summary.') {
  return `STRUCTURED_FINDINGS:\n${findingsBlock}\n\nOVERALL_SUMMARY:\n${summary}`
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
