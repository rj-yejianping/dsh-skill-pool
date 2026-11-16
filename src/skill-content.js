/**
 * Canonical `<skill_content>` rendering.
 *
 * This mirrors `renderSkillContent` from `@deepseek-ai/dsh-skill` byte for byte,
 * because the scoped replacement `skill` tool must present the same shape the
 * model already knows from the native loader: a user-explicit `/name` invocation
 * and a tool load must stay indistinguishable. Copied instead of imported so the
 * plugin keeps working when the package's internal path changes.
 *
 * @module dsh-skill-pool/skill-content
 */

/** Escape one value embedded in a double-quoted markup attribute. */
export function escapeAttr(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/** Escape model-facing prose embedded inside skill markup. */
export function escapeText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
}

/**
 * Render the resource guidance lines for one skill body.
 * @param {object} skill - loaded skill definition.
 * @returns {string[]} guidance lines.
 */
export function renderResourceHint(skill) {
  const base = skill?.resourceBase
  if (base === undefined || base === null) {
    return [
      `Resources for this skill are managed by provider "${escapeText(skill?.provider ?? 'unknown')}".`,
      'Load referenced resources only as needed.',
    ]
  }
  switch (base.kind) {
    case 'directory':
      return [
        `Base directory for this skill: ${escapeText(base.path)}`,
        'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
      ]
    case 'url':
      return [
        `Base URL for this skill: ${escapeText(base.url)}`,
        'Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.',
      ]
    case 'opaque':
      return [
        `Resources for this skill: ${escapeText(base.description)}`,
        'Load referenced resources only as needed.',
      ]
    default:
      return [
        `Resources for this skill are managed by provider "${escapeText(skill?.provider ?? 'unknown')}".`,
        'Load referenced resources only as needed.',
      ]
  }
}

/**
 * Render one loaded skill for the model.
 * @param {{name: string, provider: string, resourceBase?: object, content: string}} skill - loaded skill.
 * @returns {string} complete `<skill_content>` block.
 */
export function renderSkillContent(skill) {
  const resourceHint = renderResourceHint(skill)
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    ...resourceHint,
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}
