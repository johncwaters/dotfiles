export const meta = { name: 'qa-swarm', description: 'Routes a pinned review through the required lanes and converges their findings.', phases: [{ title: 'Route', detail: 'Rate the touched surface and select lanes.' }, { title: 'Review', detail: 'Run the selected review lanes concurrently.' }, { title: 'Converge', detail: 'Normalize and converge the lane findings.' }] }

const codexReviewSandboxProfile = `'permissions.qa_review={extends=":read-only", filesystem={"~/.ssh"="deny", "~/.gnupg"="deny", "~/.aws"="deny", "~/.kube"="deny", "~/.docker"="deny", "~/.netrc"="deny", "~/.git-credentials"="deny", "~/.config/gh"="deny", "~/.codex/auth.json"="deny", "~/.claude/.credentials.json"="deny", "~/.grok"="deny", "~/.glimmervoid/config.json*"="deny", "~/.glimmervoid/secrets.env"="deny", "~/.npmrc"="deny", "~/.azure"="deny", "~/.local/share/keyrings"="deny", "~/.mozilla"="deny", "~/.config/google-chrome"="deny", "~/.config/chromium"="deny", "~/.pki"="deny"}}'`

const dispatchNoncePattern = /^[0-9a-f]{16}$/

function dispatchPromptStem(taskLabel) {
  return `/tmp/codex-dispatch-${taskLabel}-${args.dispatchNonce}`
}

function codexDispatchCommand(model, reasoningEffort, promptStem) {
  const effortOption = reasoningEffort ? ` -c model_reasoning_effort="${reasoningEffort}"` : ''
  return 'codex exec -c ' + codexReviewSandboxProfile + ` -c 'default_permissions="qa_review"' -C ${args.repoPath} -m ${model}${effortOption} < ${promptStem}.txt 2> ${promptStem}.err`
}

function codexDispatchInstruction(promptName, taskLabel, model, reasoningEffort) {
  const promptStem = dispatchPromptStem(taskLabel)
  return `Write the ${promptName}, byte for byte, to ${promptStem}.txt. Then run exactly the one-line command below, nothing added or removed:\n${codexDispatchCommand(model, reasoningEffort, promptStem)}\n`
}

async function spawnCodexDispatcher(dispatchPrompt, options) {
  try {
    return await agent(dispatchPrompt, { model: 'sonnet', agentType: 'codex-dispatcher', ...options })
  } catch (spawnError) {
    log(`codex-dispatcher unavailable (${spawnError.message}); rerun the ai installer and start a new session`)
    return null
  }
}
const dispatchedRouterModel = 'gpt-6.1-sol'

const laneDefinitions = [
  {
    name: 'code',
    recommendable: false,
    blocking: true,
    classNeedles: [],
    trigger: '',
    spawn: (lanePrompt) => agent(lanePrompt, { model: 'opus', label: 'Code review', phase: 'Review', agentType: 'code-reviewer' })
  },
  {
    name: 'security',
    recommendable: true,
    blocking: true,
    classNeedles: ['security'],
    trigger: 'the diff touches auth, input handling, crypto, payments, PII, secrets, infrastructure, or destructive operations, or commits anything unsafe to publish, such as token or session tooling, internal hostnames, or account IDs, since every repo is judged as public',
    spawn: (lanePrompt) => agent(lanePrompt, { model: 'fable', label: 'Security review', phase: 'Review', agentType: 'security-reviewer' })
  },
  {
    name: 'structure',
    recommendable: true,
    blocking: true,
    classNeedles: ['structural', 'structure'],
    trigger: 'the diff is a refactor, establishes a new module or boundary, or moves responsibilities across existing ones',
    spawn: (lanePrompt) => agent(lanePrompt, { model: 'opus', label: 'Structure review', phase: 'Review', agentType: 'structure-reviewer' })
  },
  {
    name: 'necessity',
    recommendable: true,
    blocking: true,
    classNeedles: [],
    trigger: 'the diff introduces a net-new file, exported symbol, or doc section, and the context states a goal',
    spawn: (lanePrompt) => agent(lanePrompt, { model: 'opus', label: 'Necessity review', phase: 'Review', agentType: 'necessity-reviewer' })
  },
  {
    name: 'scale',
    recommendable: true,
    blocking: true,
    classNeedles: ['scale'],
    trigger: 'the diff adds or changes a loop, recursion, query, batch, cache, or list endpoint whose input the context does not bound by fact',
    spawn: (lanePrompt) => agent(lanePrompt, { model: 'opus', label: 'Scale review', phase: 'Review', agentType: 'scale-reviewer' })
  },
  {
    name: 'external',
    recommendable: false,
    blocking: false,
    classNeedles: [],
    trigger: '',
    spawn: (lanePrompt) => args.codexAllowed
      ? spawnCodexDispatcher(lanePrompt, { label: 'External review', phase: 'Review' })
      : agent(lanePrompt, { model: 'opus', label: 'External review', phase: 'Review' })
  }
]

const laneDefinitionsByName = new Map(laneDefinitions.map((laneDefinition) => [laneDefinition.name, laneDefinition]))
const selectableLaneNames = laneDefinitions.map((laneDefinition) => laneDefinition.name)
const recommendableLaneDefinitions = laneDefinitions.filter((laneDefinition) => laneDefinition.recommendable)
const recommendableLaneNames = recommendableLaneDefinitions.map((laneDefinition) => laneDefinition.name)
const blockingLaneNames = new Set(laneDefinitions.filter((laneDefinition) => laneDefinition.blocking).map((laneDefinition) => laneDefinition.name))
const laneTriggerTable = ['| Lane | Triggers when |', '|---|---|', ...recommendableLaneDefinitions.map((laneDefinition) => `| ${laneDefinition.name} | ${laneDefinition.trigger} |`)].join('\n')

const routerSchema = {
  type: 'object',
  properties: {
    danger: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    complexity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    dangerFact: { type: 'string' },
    fileClasses: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, class: { type: 'string' } },
        required: ['file', 'class']
      }
    },
    lanes: { type: 'array', items: { type: 'string', enum: recommendableLaneNames } },
    laneJustifications: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'string' } },
    route: { type: 'string' }
  },
  required: ['danger', 'complexity', 'dangerFact', 'fileClasses', 'lanes', 'laneJustifications', 'findings', 'route']
}

const severityRankByName = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
const mergeTagPrefixes = ['convergent: ', 'contested: ']
const reviewerTagPattern = /^[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)?$/i
const noneFormLineSource = '^[ \\t]*(?:[-*][ \\t]+)?(?:\\((?:none|no findings|nothing|empty|none found)\\)|\\[\\]|none)[ \\t]*$'
const everyNoneFormLine = new RegExp(noneFormLineSource, 'gmi')
const oneNoneFormLine = new RegExp(noneFormLineSource, 'i')
const findingRowStart = /^(?:- )?file: /
const maxFindingsPerLane = 10
const maxLanesPerRun = 3

function formatLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return '(none)'
  }
  return lines.join('\n')
}

function formatRoundState(round, isNarrowedFollowupRound, narrowingLostToScopeRestriction) {
  if (!round) {
    return 'Round state: none.'
  }
  const roundFacts = `Round number: ${round.number}\nRound touched files: ${formatLines(round.touchedFiles)}\nReporting bar: ${round.reportingBar}`
  if (isNarrowedFollowupRound) {
    return `${roundFacts}\nThis round reviews only the narrowed set and the regression and declined checks. Everything else was swept in round 1.`
  }
  if (narrowingLostToScopeRestriction) {
    return `${roundFacts}\nThis round keeps the full sweep because REVIEW_CMD already carries a scope restriction, so the narrowed set could not be applied. Focus on the round touched files and the regression and declined checks.`
  }
  return `${roundFacts}\nThis round keeps the full sweep because no narrowed changed files are available. Focus on the round touched files and the regression and declined checks.`
}

function normalizeFilePath(filePath) {
  const trimmedPath = String(filePath == null ? '' : filePath).trim()
  const repoPathPrefix = args.repoPath ? `${String(args.repoPath).replace(/\/+$/, '')}/` : ''
  if (repoPathPrefix && trimmedPath.startsWith(repoPathPrefix)) {
    return trimmedPath.slice(repoPathPrefix.length).replace(/^(\.\/)+/, '')
  }
  return trimmedPath.replace(/^(\.\/)+/, '')
}

function shellQuotedPath(filePath) {
  return `'${String(filePath).replace(/'/g, "'\\''")}'`
}

function laneNamesRecommendedBy(routerResult) {
  const recommendedLaneNames = []
  for (const recommendation of routerResult.lanes || []) {
    appendUniqueLaneName(recommendedLaneNames, String(recommendation).toLowerCase().trim())
  }
  return recommendedLaneNames
}

function withoutMergeTagPrefixes(taggedValue) {
  let remainingValue = taggedValue.trim()
  let strippedAPrefix = true
  while (strippedAPrefix) {
    strippedAPrefix = false
    for (const mergeTagPrefix of mergeTagPrefixes) {
      if (remainingValue.startsWith(mergeTagPrefix)) {
        remainingValue = remainingValue.slice(mergeTagPrefix.length).trim()
        strippedAPrefix = true
      }
    }
  }
  return remainingValue
}

function reviewerTagsFrom(reviewerValue) {
  const composedValue = String(reviewerValue == null ? '' : reviewerValue).trim()
  return composedValue.split(/ \+ | vs /).map(withoutMergeTagPrefixes).filter((reviewerTag) => reviewerTag !== '')
}

function laneOwnersFromFindings(findingLines) {
  const laneOwners = new Set()
  for (const findingLine of findingLines || []) {
    const reviewerMatch = findingLine.match(/(?:^| \| )reviewer: ([^|]+)/)
    if (!reviewerMatch) {
      continue
    }
    for (const reviewerTag of reviewerTagsFrom(reviewerMatch[1])) {
      const laneName = reviewerTag.split('/')[0]
      if (selectableLaneNames.includes(laneName)) {
        laneOwners.add(laneName)
      }
    }
  }
  return laneOwners
}

function filesClassifiedForLane(routerResult, laneName) {
  if (!routerResult) {
    return []
  }
  const laneDefinition = laneDefinitionsByName.get(laneName)
  if (!laneDefinition) {
    return []
  }
  const fileClasses = routerResult.fileClasses || []
  if (laneDefinition.classNeedles.length === 0) {
    return fileClasses
  }
  return fileClasses.filter((fileClass) => laneDefinition.classNeedles.some((classNeedle) => String(fileClass.class).toLowerCase().includes(classNeedle)))
}

function isAcceptedFindingsHeaderTail(headerTail) {
  const trimmedTail = headerTail.trim()
  if (trimmedTail === '') {
    return true
  }
  return oneNoneFormLine.test(trimmedTail) || findingRowStart.test(trimmedTail)
}

function findingsHeaderMatchesIn(text) {
  return [...text.matchAll(/^[ \t#>*-]*STRUCTURED_FINDINGS:[ \t]*(?![*_]{1,2}[ \t]*$)(?:[*_]{1,2}[ \t]*)?(.*)$/gm)].filter((headerMatch) => isAcceptedFindingsHeaderTail(headerMatch[1]))
}

function summaryHeaderMatchesIn(text) {
  return [...text.matchAll(/^[ \t#>*-]*OVERALL_SUMMARY:[ \t]*(?![*_]{1,2}[ \t]*$)(?:[*_]{1,2}[ \t]*)?(.*)$/gm)]
}

function selectedFindingsHeaderIn(text) {
  const headerMatches = findingsHeaderMatchesIn(text)
  const bareHeaderMatches = headerMatches.filter((headerMatch) => headerMatch[1].trim() === '')
  if (bareHeaderMatches.length === 1) {
    return bareHeaderMatches[0]
  }
  if (bareHeaderMatches.length === 0 && headerMatches.length === 1) {
    return headerMatches[0]
  }
  return null
}

function selectedSummaryHeaderIn(text) {
  const summaryHeaderMatches = summaryHeaderMatchesIn(text)
  if (summaryHeaderMatches.length !== 1) {
    return null
  }
  return summaryHeaderMatches[0]
}

function headerLineCandidatesIn(text, headerName) {
  const headerLines = new RegExp(`^[ \\t#>*_-]*${headerName}[ \\t]*(?::[ \\t]*(?:[*_]{1,2}[ \\t]*)?(?::[ \\t]*)?|[*_]{1,2}[ \\t]*(?::[ \\t]*)?|(?=$))(.*)$`, 'gm')
  return [...text.matchAll(headerLines)]
}

function isStrayHeaderLine(blockLine) {
  return headerLineCandidatesIn(blockLine, 'STRUCTURED_FINDINGS').length > 0 || headerLineCandidatesIn(blockLine, 'OVERALL_SUMMARY').length > 0
}

function withLastHeaderLineColonized(text, headerName, selectedHeaderIn) {
  if (selectedHeaderIn(text)) {
    return text
  }
  const headerLineCandidates = headerLineCandidatesIn(text, headerName)
  for (let candidateIndex = headerLineCandidates.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const headerLineCandidate = headerLineCandidates[candidateIndex]
    const colonizedHeaderLine = `${headerName}: ${headerLineCandidate[1]}`.trimEnd()
    const colonizedText = `${text.slice(0, headerLineCandidate.index)}${colonizedHeaderLine}${text.slice(headerLineCandidate.index + headerLineCandidate[0].length)}`
    if (selectedHeaderIn(colonizedText)) {
      return colonizedText
    }
  }
  return text
}

function withNoneFormsNormalized(text) {
  return text.replace(everyNoneFormLine, '(none)')
}

function withHeaderColons(text) {
  const withoutWrappers = text
    .replace(/^[ \t]*```[a-z]*[ \t]*$\n?/gm, '')
    .replace(/^[ \t]*END_STRUCTURED_FINDINGS:?[ \t]*\n?/gm, '')
  const withFindingsHeader = withLastHeaderLineColonized(withoutWrappers, 'STRUCTURED_FINDINGS', selectedFindingsHeaderIn)
  const withBothHeaders = withLastHeaderLineColonized(withFindingsHeader, 'OVERALL_SUMMARY', selectedSummaryHeaderIn)
  return withNoneFormsNormalized(withBothHeaders)
}

function blockAndSummaryFrom(normalizedText) {
  const findingsHeader = selectedFindingsHeaderIn(normalizedText)
  const summaryHeader = selectedSummaryHeaderIn(normalizedText)
  if (!findingsHeader || !summaryHeader) {
    return null
  }
  if (summaryHeader.index < findingsHeader.index) {
    return null
  }
  const assembledBlockText = `${findingsHeader[1]}${normalizedText.slice(findingsHeader.index + findingsHeader[0].length, summaryHeader.index)}`
  return {
    blockText: withNoneFormsNormalized(assembledBlockText).trim(),
    summaryText: `${summaryHeader[1]}${normalizedText.slice(summaryHeader.index + summaryHeader[0].length)}`.trim(),
  }
}

function lineFieldIsValid(lineValue) {
  if (lineValue.trim().toLowerCase() === 'general') {
    return true
  }
  return /^[0-9]+$/.test(lineValue.trim()) && Number(lineValue.trim()) > 0
}

function reviewerFieldIsValid(reviewerValue) {
  const reviewerTags = reviewerTagsFrom(reviewerValue)
  if (reviewerTags.length === 0) {
    return false
  }
  return reviewerTags.every((reviewerTag) => reviewerTagPattern.test(reviewerTag))
}

function rawFindingLineFrom(fields) {
  const rawFieldTexts = [`file: ${fields.file}`, `line: ${fields.line}`]
  if (fields.side) {
    rawFieldTexts.push(`side: ${fields.side}`)
  }
  rawFieldTexts.push(`severity: ${fields.severity}`, `reviewer: ${fields.reviewer}`, `body: ${fields.body}`)
  return `- ${rawFieldTexts.join(' | ')}`
}

function parseFindingLine(findingLine) {
  const normalizedLine = findingLine.trim().replace(/^- /, '')
  if (!normalizedLine.startsWith('file: ')) {
    return null
  }
  const bodySeparator = ' | body: '
  const bodySeparatorIndex = normalizedLine.indexOf(bodySeparator)
  if (bodySeparatorIndex < 0) {
    return null
  }
  const fields = { body: normalizedLine.slice(bodySeparatorIndex + bodySeparator.length).trim() }
  if (fields.body === '') {
    return null
  }
  for (const fieldText of normalizedLine.slice(0, bodySeparatorIndex).split(' | ')) {
    const separatorIndex = fieldText.indexOf(': ')
    if (separatorIndex < 1) {
      return null
    }
    fields[fieldText.slice(0, separatorIndex)] = fieldText.slice(separatorIndex + 2).trim()
  }
  if (!fields.file || !fields.line || !fields.severity || !fields.reviewer) {
    return null
  }
  if (!lineFieldIsValid(fields.line) || !reviewerFieldIsValid(fields.reviewer)) {
    return null
  }
  const normalizedSeverity = fields.severity.trim().toUpperCase()
  if (severityRankByName[normalizedSeverity] === undefined) {
    return null
  }
  fields.severity = normalizedSeverity
  fields.file = normalizeFilePath(fields.file)
  const anchorsWholeFile = fields.line.trim().toLowerCase() === 'general'
  if (anchorsWholeFile) {
    fields.line = 'general'
    delete fields.side
  }
  if (!anchorsWholeFile) {
    const declaredSide = (fields.side || 'RIGHT').trim().toUpperCase()
    if (declaredSide !== 'RIGHT' && declaredSide !== 'LEFT') {
      return null
    }
    fields.side = declaredSide
  }
  return { raw: rawFindingLineFrom(fields), fields }
}

function severityRankOf(parsedFinding) {
  return severityRankByName[parsedFinding.fields.severity]
}

function deadLaneResponse() {
  return { hasParseableBlock: false, hasUnparseableRow: false, findings: [], summary: '', hitFindingCap: false }
}

function findingIdentityOf(parsedFinding) {
  const { file, line, side, severity, reviewer } = parsedFinding.fields
  return [file, line, side || '', severity, reviewer].join('|')
}

function findingIdentitiesOf(parsedResponse) {
  return parsedResponse.findings.map(findingIdentityOf).sort().join('\n')
}

function isCleanlyParsed(parsedResponse) {
  return parsedResponse.hasParseableBlock && !parsedResponse.hasUnparseableRow
}

function responseAgreedAcrossRepeatedBlocks(laneText, bareFindingsHeaders) {
  const repeatedBlockTexts = bareFindingsHeaders.map((findingsHeader, headerIndex) => {
    const nextHeader = bareFindingsHeaders[headerIndex + 1]
    return laneText.slice(findingsHeader.index, nextHeader ? nextHeader.index : undefined)
  })
  const uncappedResponses = repeatedBlockTexts.map((blockText) => parseSingleBlockResponse(blockText, Infinity))
  if (!uncappedResponses.every(isCleanlyParsed)) {
    return deadLaneResponse()
  }
  const lastIdentities = findingIdentitiesOf(uncappedResponses[uncappedResponses.length - 1])
  if (!uncappedResponses.every((uncappedResponse) => findingIdentitiesOf(uncappedResponse) === lastIdentities)) {
    return deadLaneResponse()
  }
  return parseSingleBlockResponse(repeatedBlockTexts[repeatedBlockTexts.length - 1])
}

function parseLaneResponse(rawLaneText) {
  if (typeof rawLaneText !== 'string' || rawLaneText.trim() === '') {
    return deadLaneResponse()
  }
  const laneText = withHeaderColons(rawLaneText)
  const bareFindingsHeaders = findingsHeaderMatchesIn(laneText).filter((headerMatch) => headerMatch[1].trim() === '')
  if (bareFindingsHeaders.length > 1) {
    return responseAgreedAcrossRepeatedBlocks(laneText, bareFindingsHeaders)
  }
  return parseSingleBlockResponse(laneText)
}

function parseSingleBlockResponse(laneText, findingLimit = maxFindingsPerLane) {
  const deadResponse = deadLaneResponse()
  const splitResponse = blockAndSummaryFrom(laneText)
  if (!splitResponse) {
    return deadResponse
  }
  const summary = splitResponse.summaryText
  if (summary === '') {
    return deadResponse
  }
  const blockText = splitResponse.blockText
  if (blockText === '(none)') {
    return { hasParseableBlock: true, hasUnparseableRow: false, findings: [], summary, hitFindingCap: false }
  }
  const parsedRows = blockText.split('\n').map((blockLine) => blockLine.trim()).filter((blockLine) => blockLine !== '' && !isStrayHeaderLine(blockLine)).map(parseFindingLine)
  const hasUnparseableRow = parsedRows.some((parsedRow) => !parsedRow)
  const rankedFindings = parsedRows.filter(Boolean).sort((leftFinding, rightFinding) => severityRankOf(leftFinding) - severityRankOf(rightFinding))
  const keptFindings = rankedFindings.slice(0, findingLimit)
  return { hasParseableBlock: rankedFindings.length > 0, hasUnparseableRow, findings: keptFindings, summary, hitFindingCap: rankedFindings.length >= findingLimit }
}

function truncatedLaneTagsFrom(summaryText) {
  const truncatedMatch = summaryText.match(/truncated lanes:[ \t]*([^.\n]*)/i)
  if (!truncatedMatch) {
    return null
  }
  const declaredTagText = truncatedMatch[1].trim()
  if (declaredTagText.toLowerCase() === 'none') {
    return new Set()
  }
  return new Set(declaredTagText.split(',').map((laneTag) => laneTag.trim().toLowerCase()).filter((laneTag) => laneTag !== ''))
}

function findConvergenceValidationFailure(rawJudgmentText, cappedLaneNames, reviewedFileNameSet) {
  if (typeof rawJudgmentText !== 'string') {
    return 'no parseable block'
  }
  const parsedJudgment = parseLaneResponse(rawJudgmentText)
  if (parsedJudgment.hasUnparseableRow) {
    return 'an unparseable row'
  }
  if (!parsedJudgment.hasParseableBlock) {
    return 'no parseable block'
  }
  if (parsedJudgment.findings.some((parsedFinding) => !reviewedFileNameSet.has(parsedFinding.fields.file))) {
    return 'a file outside the reviewed set'
  }
  const declaredTruncatedLaneTags = truncatedLaneTagsFrom(parsedJudgment.summary)
  if (!declaredTruncatedLaneTags) {
    return 'the missing `truncated lanes:` phrase'
  }
  if (!cappedLaneNames.every((cappedLaneName) => declaredTruncatedLaneTags.has(cappedLaneName.toLowerCase()))) {
    return 'the missing `truncated lanes:` phrase naming every required lane'
  }
  return null
}

function isConvergedBlock(rawJudgmentText, cappedLaneNames, reviewedFileNameSet) {
  return findConvergenceValidationFailure(rawJudgmentText, cappedLaneNames, reviewedFileNameSet) === null
}

function buildRouterAssessmentPrompt(filesToClassify, routeInstruction, routeOutcomeInstruction = '') {
  return `Scope: classify and review ${formatLines(filesToClassify)} under ${args.reviewCmd}
Out of scope: pre-existing issues outside that changed-file set; unchanged lines may be read but never anchored
Definition of done: return the validated router object described below

${routeInstruction}
Repo path: ${args.repoPath}
Exact REVIEW_CMD: ${args.reviewCmd}
Caller context, verbatim:
${args.context}
Files to classify:
${formatLines(filesToClassify)}

Rate danger and complexity LOW, MEDIUM, or HIGH. Give the one-sentence fact that set danger. Classify each supplied file into one or more of logic, security surface, structural, scale surface, config, test, or docs. Scale surface means iteration, recursion, queries, or accumulation over a collection whose size the context does not bound. Recommend a lane only when its trigger is clearly met by a specific file, and name that file in the matching laneJustifications entry. List recommended lanes most valuable first. A diff under roughly 5 changed files rarely needs more than one recommended lane. Recommend lanes from this table and no other source:

${laneTriggerTable}

The code lane always runs and the external lane follows from your ratings, so neither is recommendable here. Put bare lane names in lanes, and one justification clause per recommended lane, in the same order, in laneJustifications. Return any real findings as complete STRUCTURED_FINDINGS lines tagged router, anchored to the changed set. ${routeOutcomeInstruction}Return JSON matching this schema:
${JSON.stringify(routerSchema)}`
}

async function routeReviewOnOpus(filesToClassify, fallbackReason) {
  const fallbackRouteInstruction = `Act as the router because the external route reported ${fallbackReason}. Read the repo and run the exact REVIEW_CMD. Do not spawn or dispatch anything.`
  const fallbackRoute = args.codexAllowed ? 'opus' : 'opus-codex-substitute'
  const fallbackPrompt = buildRouterAssessmentPrompt(filesToClassify, fallbackRouteInstruction, `Set route to ${fallbackRoute}. `)
  const fallbackRouter = await agent(fallbackPrompt, { model: 'opus', label: 'Route review fallback', phase: 'Route', schema: routerSchema })
  if (!fallbackRouter) {
    return null
  }
  return { ...fallbackRouter, route: fallbackRoute }
}

function describeRouterDispatchFailure(dispatchedRouter) {
  if (!dispatchedRouter) {
    return 'router agent death'
  }
  return String(dispatchedRouter.dangerFact || '').trim()
}

function hasClassifiedAnyFile(routerAnswer) {
  if (!routerAnswer || !Array.isArray(routerAnswer.fileClasses)) {
    return false
  }
  return routerAnswer.fileClasses.length > 0
}

async function routeReview(filesToClassify) {
  phase('Route')
  if (!args.codexAllowed) {
    return { routerResult: await routeReviewOnOpus(filesToClassify, 'Codex CLI disabled by session routing'), degradationNote: '' }
  }
  const dispatchRouteInstruction = `You are a dispatcher only. Do not answer the router questions yourself. ${codexDispatchInstruction('dispatched router prompt below', 'router', dispatchedRouterModel, 'medium')}On any failure, return the required placeholder object with route OPUS_REQUIRED. The placeholder uses LOW for both ratings, your one-line failure report as dangerFact, empty arrays, and no guessed review answer. On success, return the Codex JSON verbatim.\n\nDispatched router prompt:`
  const dispatchPrompt = buildRouterAssessmentPrompt(filesToClassify, dispatchRouteInstruction)
  const dispatchedRouter = await spawnCodexDispatcher(dispatchPrompt, { label: 'Route review', phase: 'Route', schema: routerSchema })
  if (hasClassifiedAnyFile(dispatchedRouter)) {
    return { routerResult: { ...dispatchedRouter, route: dispatchedRouterModel }, degradationNote: '' }
  }
  const dispatchFailureDetail = describeRouterDispatchFailure(dispatchedRouter)
  const routeFailureReason = dispatchFailureDetail === '' ? 'a failed dispatch with no reported detail' : dispatchFailureDetail
  const fallbackRouterResult = await routeReviewOnOpus(filesToClassify, routeFailureReason)
  return { routerResult: fallbackRouterResult, degradationNote: `external router failed with ${routeFailureReason}, so opus routed instead and the routing row for this run is stale` }
}

function securityIsForcedBy(routerResult) {
  if (routerResult.danger === 'HIGH') {
    return true
  }
  return filesClassifiedForLane(routerResult, 'security').length > 0
}

function laneOwnersCarriedIntoThisRound() {
  return laneOwnersFromFindings([...(args.claimedFixed || []), ...(args.declined || [])])
}

function appendUniqueLaneName(laneNames, laneName) {
  if (!selectableLaneNames.includes(laneName) || laneNames.includes(laneName)) {
    return
  }
  laneNames.push(laneName)
}

function appendCarriedLaneNames(targetLaneNames, carriedLaneOwners, excludedLaneNames) {
  for (const carriedLaneName of carriedLaneOwners) {
    if (excludedLaneNames.includes(carriedLaneName)) {
      continue
    }
    appendUniqueLaneName(targetLaneNames, carriedLaneName)
  }
}

function applyLaneCap(candidateLaneNames, reason) {
  return {
    laneNames: candidateLaneNames.slice(0, maxLanesPerRun),
    laneNamesCutByCap: candidateLaneNames.slice(maxLanesPerRun),
    reason
  }
}

function selectLaneNames(routerResult, isNarrowedFollowupRound) {
  const carriedLaneOwners = laneOwnersCarriedIntoThisRound()
  if (isNarrowedFollowupRound) {
    const followupLaneNames = ['code']
    if (carriedLaneOwners.has('security')) {
      followupLaneNames.push('security')
    }
    appendCarriedLaneNames(followupLaneNames, carriedLaneOwners, ['code', 'security', 'necessity', 'external'])
    if (carriedLaneOwners.has('external')) {
      followupLaneNames.push('external')
    }
    return applyLaneCap(followupLaneNames, 'follow-up rounds use code plus carried claimed-fixed and declined owners, never necessity, with external last only when carried')
  }
  if (!routerResult) {
    const noRouterLaneNames = ['code', 'security']
    appendCarriedLaneNames(noRouterLaneNames, carriedLaneOwners, ['external'])
    return applyLaneCap(noRouterLaneNames, 'the router was unavailable, so the no-router default applies, unioned with carried claimed-fixed and declined lane owners except external')
  }
  const recommendedLaneNames = laneNamesRecommendedBy(routerResult)
  const candidateLaneNames = ['code']
  if (securityIsForcedBy(routerResult)) {
    candidateLaneNames.push('security')
  }
  for (const laneName of recommendedLaneNames) {
    appendUniqueLaneName(candidateLaneNames, laneName)
  }
  if (args.round && args.round.number >= 2) {
    appendCarriedLaneNames(candidateLaneNames, carriedLaneOwners, ['external'])
  }
  if (routerResult.danger === 'HIGH') {
    candidateLaneNames.push('external')
  }
  if (!args.round || args.round.number < 2) {
    return applyLaneCap(candidateLaneNames, 'round one uses router recommendations in value order, forces security on a security-surface file or HIGH danger, and adds external last only for HIGH danger')
  }
  return applyLaneCap(candidateLaneNames, 'a later round with no touched files keeps router recommendations and carried owners, forces security on its existing rule, and adds external last only for HIGH danger')
}

function buildLanePrompt(laneName, routerResult, laneNames, reviewedFileNames, reviewCmd, isNarrowedFollowupRound, narrowingLostToScopeRestriction) {
  const routerRatings = routerResult ? `danger ${routerResult.danger}; complexity ${routerResult.complexity}; danger fact ${routerResult.dangerFact}; route ${routerResult.route}` : 'router unavailable'
  const classifiedFiles = routerResult ? JSON.stringify(filesClassifiedForLane(routerResult, laneName)) : '(router unavailable)'
  const lanePrompt = `Scope: changed files ${formatLines(reviewedFileNames)} under ${reviewCmd}
Out of scope: pre-existing issues outside that set; unchanged lines inside it are read, never anchored
Definition of done: this lane's STRUCTURED_FINDINGS block followed by one OVERALL_SUMMARY paragraph

Repo path: ${args.repoPath}
Exact REVIEW_CMD: ${reviewCmd}
Caller context, verbatim:
${args.context}

Settled ground not to re-flag:
${formatLines(args.settled)}

Claimed fixed regression checks: confirm each of these is actually gone, report again at its severity if still present, exempt from any reporting bar. Report a finding that is still present under this lane's own tag, with its original reviewer tag at the start of the body. A carried check is exempt from the lane-discipline rule, so whichever lane checks it reports it whatever discipline it belongs to:
${formatLines(args.claimedFixed)}

Declined findings: report each again if still present, exempt from any bar. Report a finding that is still present under this lane's own tag, with its original reviewer tag at the start of the body. A carried check is exempt from the lane-discipline rule here too, so report it even when it belongs to another lane's discipline:
${formatLines(args.declined)}

${formatRoundState(args.round, isNarrowedFollowupRound, narrowingLostToScopeRestriction)}
Router ratings: ${routerRatings}
Files classified into this lane: ${classifiedFiles}
Spawned lane set: ${laneNames.join(', ')}

Review checklist: if ~/.claude/review-checklist.md exists, read it and apply items under ## ${laneName} as extra checks.
The checklist only adds checks; it never changes the severity ladder, finding cap, scope, or output format.`
  if (laneName !== 'external') {
    return `${lanePrompt}

Everything above is this run's additions. Your agent definition owns the severity ladder, the finding cap, and the output format; follow it exactly and write nothing after the block it prescribes.`
  }
  const externalLanePrompt = `${lanePrompt}

Find real defects with a concrete failure scenario. MEDIUM is the minimum severity and NIT is forbidden. Anything below MEDIUM is not a finding and may appear in at most one summary sentence. Anchor each finding to a line the diff adds or removes, or to general for a file-level defect. Emit at most 10 findings, highest severity first, and when that cap dropped findings say in one summary sentence the verbatim phrase overflow dropped followed by how many, never writing those two words otherwise.

STRUCTURED_FINDINGS:
- file: <path> | line: <number or general> | side: <RIGHT|LEFT> | severity: <CRITICAL|HIGH|MEDIUM> | reviewer: external or external/<category> | body: <problem, concrete failure scenario, fix>
- file: ...

OVERALL_SUMMARY:
<one paragraph>

For no findings, put (none) on the line after STRUCTURED_FINDINGS:. Omit side when line is general. Use one finding per line with no bare | inside body.`
  if (!args.codexAllowed) {
    return `${externalLanePrompt}\n\nCodex CLI is disabled by session routing. Act as its opus substitute and perform an adversarial independent read that tries to refute the other lanes before reporting findings.`
  }
  return `${externalLanePrompt}\n\n${codexDispatchInstruction('review prompt above', 'external', 'gpt-6.1-sol', 'high')}Return the output verbatim. On any failure, return the literal string EXTERNAL_UNAVAILABLE.`
}

function spawnLane(laneName, lanePrompt) {
  const laneDefinition = laneDefinitionsByName.get(laneName)
  if (!laneDefinition) {
    return null
  }
  return laneDefinition.spawn(lanePrompt)
}

function formatRouterSummary(routerResult, routingNote) {
  if (routingNote !== '') {
    return routingNote
  }
  if (!routerResult) {
    return 'unavailable; no-router default'
  }
  return `${routerResult.danger}/${routerResult.complexity} via ${routerResult.route}; ${routerResult.dangerFact}`
}

function formatTagList(tagValues) {
  if (tagValues.length === 0) {
    return 'none'
  }
  return tagValues.join(', ')
}

function buildConvergenceFacts(laneNames, skippedLaneNames, degradationNotes, routerResult, routingNote, droppedFindingCount, droppedBelowMediumCount, droppedOutOfLaneCount, droppedOutOfLaneTags, cappedLaneNames) {
  return {
    lanesRun: laneNames.join(', '),
    lanesSkipped: formatTagList(skippedLaneNames),
    degraded: degradationNotes.length > 0 ? degradationNotes.join('; ') : 'none',
    routerRatings: formatRouterSummary(routerResult, routingNote),
    droppedFindingCount,
    droppedBelowMediumCount,
    droppedOutOfLaneCount,
    droppedOutOfLaneTags: formatTagList(droppedOutOfLaneTags),
    truncatedLanes: formatTagList(cappedLaneNames)
  }
}

function formatConvergenceSummary(survivingFindingCount, convergenceFacts) {
  return `${survivingFindingCount} finding(s) survived. Lanes run: ${convergenceFacts.lanesRun}. Lanes skipped: ${convergenceFacts.lanesSkipped}. Degraded: ${convergenceFacts.degraded}. Router ratings and route: ${convergenceFacts.routerRatings}. Dropped ${convergenceFacts.droppedFindingCount} finding(s) outside the reviewed-file set. Dropped below MEDIUM: ${convergenceFacts.droppedBelowMediumCount}. Dropped out of lane: ${convergenceFacts.droppedOutOfLaneCount}, tags: ${convergenceFacts.droppedOutOfLaneTags}. truncated lanes: ${convergenceFacts.truncatedLanes}`
}

function buildJudgmentPrompt(convergenceFacts, groupedFindings, routerFindings, laneSummaries, reviewedFileNames, reviewCmd) {
  const tiebreakInstruction = 'Grok CLI is unreachable from subagents, so act as its opus substitute: isolate the two positions of each contradiction and rule from those positions alone.'
  return `Scope: converge findings for reviewed files ${formatLines(reviewedFileNames)} under ${reviewCmd}
Out of scope: findings outside that reviewed-file set, new review work, verdicts, fixes, and recommendations
Definition of done: one final block opened by the exact line STRUCTURED_FINDINGS: (with the trailing colon) followed by one paragraph opened by the exact line OVERALL_SUMMARY: (with the trailing colon), and no trailing text

Grouped lane findings:
${JSON.stringify(groupedFindings)}

Router findings:
${JSON.stringify(routerFindings)}

Lane summaries, supplied only to recognize explicit verified-safe contradictions and overflow reports:
${JSON.stringify(laneSummaries)}

Lanes run: ${convergenceFacts.lanesRun}
Lanes skipped: ${convergenceFacts.lanesSkipped}
Degraded: ${convergenceFacts.degraded}
Router ratings and route: ${convergenceFacts.routerRatings}
Dropped outside the reviewed-file set: ${convergenceFacts.droppedFindingCount}
Dropped below MEDIUM: ${convergenceFacts.droppedBelowMediumCount}
Dropped out of lane: ${convergenceFacts.droppedOutOfLaneCount}, tags: ${convergenceFacts.droppedOutOfLaneTags}
Truncated lane tags: ${convergenceFacts.truncatedLanes}

Merge findings on the same file within 5 lines, or plainly the same concern in different words, into one finding tagged convergent: <tag> + <tag>. Keep the highest severity and name the lane that assigned it in the body. Convergence confirms confidence but does not itself raise severity. A necessity finding never merges with another lane's finding.

A contradiction is one lane asserting a defect and another explicitly verifying it safe. ${tiebreakInstruction} No ruling available: emit the asserting finding once tagged contested: <asserting lane> vs <disputing lane>, include the disputing reasoning in the body, and end the body with Confidence: low, tiebreak unavailable.

A lane summary reports findings its own cap dropped with the verbatim phrase overflow dropped. Treat every lane whose summary carries that phrase as truncated too, alongside the truncated lane tags supplied above.

Return the reviewer output format exactly. The summary is one paragraph carrying exactly this text, with the surviving finding count in place of <count>:

${formatConvergenceSummary('<count>', convergenceFacts)}

When zero findings survive, put the literal (none) on the line after STRUCTURED_FINDINGS:. Extend the lane list after the verbatim phrase \"truncated lanes: \" with every lane whose summary carries the phrase overflow dropped, comma-separated, and write none when that union is empty. Do not return a verdict, risk tier, fix, or recommendation.`
}

function isFollowupRoundWithTouchedFiles() {
  return Boolean(args.round && args.round.number >= 2 && Array.isArray(args.round.touchedFiles) && args.round.touchedFiles.length > 0)
}

function narrowFileNamesForFollowup(changedFileNames) {
  const candidateFileNames = [...args.round.touchedFiles]
  for (const findingLine of [...(args.claimedFixed || []), ...(args.declined || [])]) {
    const parsedFinding = parseFindingLine(findingLine)
    if (!parsedFinding) {
      continue
    }
    candidateFileNames.push(parsedFinding.fields.file)
  }
  const narrowedFileNames = []
  for (const candidateFileName of candidateFileNames) {
    const normalizedCandidateFileName = normalizeFilePath(candidateFileName)
    if (!changedFileNames.has(normalizedCandidateFileName) || narrowedFileNames.includes(normalizedCandidateFileName)) {
      continue
    }
    narrowedFileNames.push(normalizedCandidateFileName)
  }
  return narrowedFileNames
}

function isFindingOwnedByLane(parsedFinding, laneName) {
  return reviewerTagsFrom(parsedFinding.fields.reviewer).some((reviewerTag) => {
    const normalizedReviewerTag = reviewerTag.toLowerCase()
    return normalizedReviewerTag === laneName || normalizedReviewerTag.startsWith(`${laneName}/`)
  })
}

function retaggedToLane(parsedFinding, laneName) {
  const retaggedFields = { ...parsedFinding.fields, reviewer: laneName, body: `originally ${parsedFinding.fields.reviewer}: ${parsedFinding.fields.body}` }
  return { raw: rawFindingLineFrom(retaggedFields), fields: retaggedFields }
}

function reportsOverflow(summaryText) {
  return /\boverflow dropped\b/i.test(summaryText)
}

function canConvergeMechanically(survivingFindings, laneSummaries) {
  if (survivingFindings.length === 0) {
    return true
  }
  if (laneSummaries.some((laneSummary) => reportsOverflow(laneSummary.summary))) {
    return false
  }
  const findingLaneNames = new Set(survivingFindings.map((survivingFinding) => survivingFinding.lane))
  if (findingLaneNames.size !== 1) {
    return false
  }
  return !laneSummaries.some((laneSummary) => /verified safe/i.test(laneSummary.summary))
}

function buildMechanicalConvergence(survivingFindings, convergenceFacts) {
  const rankedFindingLines = [...survivingFindings]
    .sort((leftFinding, rightFinding) => severityRankOf(leftFinding.finding) - severityRankOf(rightFinding.finding))
    .map((survivingFinding) => survivingFinding.finding.raw)
  const findingsBlock = rankedFindingLines.length > 0 ? rankedFindingLines.join('\n') : '(none)'
  return `STRUCTURED_FINDINGS:\n${findingsBlock}\n\nOVERALL_SUMMARY:\n${formatConvergenceSummary(survivingFindings.length, convergenceFacts)}`
}

if (!args.reviewCmd) {
  return 'No REVIEW_CMD, no run.'
}

if (!Array.isArray(args.changedFiles) || args.changedFiles.length === 0) {
  return 'No changed-file set, no run.'
}

if (typeof args.codexAllowed !== 'boolean' || typeof args.grokAllowed !== 'boolean') {
  return 'No valid codexAllowed and grokAllowed routing flags, no run.'
}

if (args.codexAllowed && !dispatchNoncePattern.test(String(args.dispatchNonce ?? ''))) {
  return 'No valid dispatchNonce for a Codex-allowed run, no run.'
}

const changedFileNames = new Set(args.changedFiles.map(normalizeFilePath))
const narrowedFollowupFileNames = isFollowupRoundWithTouchedFiles() ? narrowFileNamesForFollowup(changedFileNames) : []
const reviewCmdCarriesScopeRestriction = String(args.reviewCmd).includes(' -- ')
const isNarrowedFollowupRound = narrowedFollowupFileNames.length > 0 && !reviewCmdCarriesScopeRestriction
const narrowingLostToScopeRestriction = narrowedFollowupFileNames.length > 0 && reviewCmdCarriesScopeRestriction
const reviewedFileNames = isNarrowedFollowupRound ? narrowedFollowupFileNames : [...changedFileNames]
const reviewedFileNameSet = new Set(reviewedFileNames)
const laneReviewCmd = isNarrowedFollowupRound ? `${args.reviewCmd} -- ${reviewedFileNames.map(shellQuotedPath).join(' ')}` : args.reviewCmd
const filesToClassify = isFollowupRoundWithTouchedFiles() ? args.round.touchedFiles : args.changedFiles
const routingNote = isNarrowedFollowupRound ? `routing skipped because round ${args.round.number} is a follow-up` : ''
const routeOutcome = isNarrowedFollowupRound
  ? { routerResult: null, degradationNote: '' }
  : await routeReview(filesToClassify)
const routerResult = routeOutcome.routerResult
const laneSelection = selectLaneNames(routerResult, isNarrowedFollowupRound)
const laneNames = laneSelection.laneNames
const laneNamesCutByCap = laneSelection.laneNamesCutByCap
const laneNamesCutByCapForLog = laneNamesCutByCap.length > 0 ? laneNamesCutByCap.join(', ') : 'none'
log(`Chosen lanes: ${laneNames.join(', ')} because ${laneSelection.reason}. Cut by the ${maxLanesPerRun}-lane cap: ${laneNamesCutByCapForLog}.`)

phase('Review')
const lanePrompts = new Map(laneNames.map((laneName) => [laneName, buildLanePrompt(laneName, routerResult, laneNames, reviewedFileNames, laneReviewCmd, isNarrowedFollowupRound, narrowingLostToScopeRestriction)]))
const laneTexts = await parallel(laneNames.map((laneName) => () => spawnLane(laneName, lanePrompts.get(laneName))))
const parsedResponses = new Map()
const degradationNotes = routeOutcome.degradationNote === '' ? [] : [routeOutcome.degradationNote]
if (narrowingLostToScopeRestriction) {
  degradationNotes.push('REVIEW_CMD already carries a scope restriction, so this follow-up round swept the full changed-file set instead of narrowing to the touched files')
}

for (let laneIndex = 0; laneIndex < laneNames.length; laneIndex += 1) {
  const laneName = laneNames[laneIndex]
  const laneText = laneTexts[laneIndex]
  if (laneName === 'external' && (laneText === null || laneText === 'EXTERNAL_UNAVAILABLE')) {
    degradationNotes.push('external unavailable')
    continue
  }
  const parsedResponse = parseLaneResponse(laneText)
  if (blockingLaneNames.has(laneName) && (!parsedResponse.hasParseableBlock || parsedResponse.hasUnparseableRow)) {
    return `LANE_DEATH: ${laneName}`
  }
  if (laneName === 'external' && !parsedResponse.hasParseableBlock) {
    degradationNotes.push('external returned no parseable block')
    continue
  }
  parsedResponses.set(laneName, parsedResponse)
}

if (!routerResult && !isNarrowedFollowupRound) {
  degradationNotes.push('router unavailable; no-router default lane set used')
}

const findingsByFile = new Map()
const survivingLaneFindings = []
const parsedRouterFindings = []
let droppedFindingCount = 0
let droppedBelowMediumCount = 0
let droppedOutOfLaneCount = 0
const droppedOutOfLaneTags = new Set()

for (const [laneName, parsedResponse] of parsedResponses) {
  for (const parsedFinding of parsedResponse.findings) {
    if (parsedFinding.fields.severity === 'LOW') {
      droppedBelowMediumCount += 1
      continue
    }
    const isOwnedByLane = isFindingOwnedByLane(parsedFinding, laneName)
    if (!isOwnedByLane && severityRankOf(parsedFinding) > severityRankByName.HIGH) {
      droppedOutOfLaneCount += 1
      droppedOutOfLaneTags.add(parsedFinding.fields.reviewer)
      continue
    }
    const keptFinding = isOwnedByLane ? parsedFinding : retaggedToLane(parsedFinding, laneName)
    const findingFileName = keptFinding.fields.file
    if (!reviewedFileNameSet.has(findingFileName)) {
      droppedFindingCount += 1
      continue
    }
    const findingsForFile = findingsByFile.get(findingFileName) || []
    findingsForFile.push({ lane: laneName, line: keptFinding.raw })
    findingsByFile.set(findingFileName, findingsForFile)
    survivingLaneFindings.push({ lane: laneName, finding: keptFinding })
  }
}

for (const routerFindingLine of routerResult ? routerResult.findings || [] : []) {
  const parsedRouterFinding = parseFindingLine(routerFindingLine)
  if (!parsedRouterFinding) {
    continue
  }
  if (parsedRouterFinding.fields.severity === 'LOW') {
    droppedBelowMediumCount += 1
    continue
  }
  if (!reviewedFileNameSet.has(parsedRouterFinding.fields.file)) {
    droppedFindingCount += 1
    continue
  }
  parsedRouterFindings.push(parsedRouterFinding)
}

const rankedRouterFindings = parsedRouterFindings.sort((leftFinding, rightFinding) => severityRankOf(leftFinding) - severityRankOf(rightFinding))
const keptRouterFindings = rankedRouterFindings.slice(0, maxFindingsPerLane)
const routerFindings = keptRouterFindings.map((parsedFinding) => parsedFinding.raw)

const groupedFindings = [...findingsByFile].map(([file, findings]) => ({ file, findings }))
const cappedLaneNames = [...parsedResponses].filter(([, parsedResponse]) => parsedResponse.hitFindingCap || reportsOverflow(parsedResponse.summary)).map(([laneName]) => laneName)
if (rankedRouterFindings.length > routerFindings.length) {
  cappedLaneNames.push('router')
}
const laneSummaries = [...parsedResponses].map(([laneName, parsedResponse]) => ({ lane: laneName, summary: parsedResponse.summary }))
const skippedLaneNames = selectableLaneNames.filter((laneName) => !laneNames.includes(laneName))
const survivingFindings = [
  ...survivingLaneFindings,
  ...keptRouterFindings.map((parsedFinding) => ({ lane: 'router', finding: parsedFinding }))
]

phase('Converge')
const convergenceFacts = buildConvergenceFacts(laneNames, skippedLaneNames, degradationNotes, routerResult, routingNote, droppedFindingCount, droppedBelowMediumCount, droppedOutOfLaneCount, [...droppedOutOfLaneTags], cappedLaneNames)
if (canConvergeMechanically(survivingFindings, laneSummaries)) {
  const mechanicalConvergence = buildMechanicalConvergence(survivingFindings, convergenceFacts)
  if (!isConvergedBlock(mechanicalConvergence, cappedLaneNames, reviewedFileNameSet)) {
    return 'LANE_DEATH: judgment'
  }
  return mechanicalConvergence
}

const judgmentPrompt = buildJudgmentPrompt(convergenceFacts, groupedFindings, routerFindings, laneSummaries, reviewedFileNames, laneReviewCmd)
const convergedFindings = await agent(judgmentPrompt, { model: 'opus', label: 'Converge findings', phase: 'Converge' })
const firstValidationFailure = findConvergenceValidationFailure(convergedFindings, cappedLaneNames, reviewedFileNameSet)
if (!firstValidationFailure) {
  return convergedFindings
}
const resumeSafeRetryId = args.retryAttemptId ?? `${args.reviewCmd} round ${args.round?.number ?? 1}`
const retryJudgmentPrompt = `Retry attempt id: ${resumeSafeRetryId}\n\nValidation failure reason: ${firstValidationFailure}\n\n${judgmentPrompt}`
const retriedConvergedFindings = await agent(retryJudgmentPrompt, { model: 'opus', label: 'Retry converge findings', phase: 'Converge' })
if (!isConvergedBlock(retriedConvergedFindings, cappedLaneNames, reviewedFileNameSet)) {
  return 'LANE_DEATH: judgment'
}
return retriedConvergedFindings
