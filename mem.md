# mem.md — CommerceOS Skill Index

This file lists the skills that are relevant for CommerceOS and when to use them.
It is intentionally selective: call the skill that matches the task type, not every skill at once.

## How to use this file

- For a new UI or visual change, start with **frontend-design** or **impeccable** depending on the surface.
- For debugging, start with **systematic-debugging** and then apply a review or refactor skill.
- For a big feature, create a plan first with **writing-plans** or **brainstorming**.
- For code reviews, use **review-pr** or **review-delta**.
- For design system work, use **design-consultation** or **frontend-design**.
- For implementation discipline, use **karpathy-guidelines** and **verification-before-completion**.

## Quick route by task

| Task | First skill(s) | Notes |
| --- | --- | --- |
| New landing / marketing page | frontend-design, taste-skill | Use for visual identity, copy, and layout intent |
| Product UI / dashboard polish | impeccable, frontend-design | Use for UX, hierarchy, motion, and component craft |
| Brand system or DESIGN.md | design-consultation, frontend-design | Use for tokens, type, color, motion system |
| Plan a multi-step feature | writing-plans, brainstorming | Use before editing code |
| Debug failing build or test | systematic-debugging | Use before making any fix |
| Refactor with low risk | refactor-safely, karpathy-guidelines | Use for surgical changes |
| Review PR or branch | review-pr, review-delta | Use for structural review and blast radius |
| Animation or motion intent | animation-vocabulary | Use to name effects before building them |
| Final verification before completion | verification-before-completion | Use before claiming done |

## Skill details

### frontend-design
- Path: _skill-downloads/claude-code/plugins/frontend-design/skills/frontend-design/SKILL.md
- Source repo: anthropics/claude-code
- Use for: visual direction, typography, layout intent, and avoiding templated defaults
- Call when: building new UI, reshaping an existing page, or choosing a visual system
- Key behavior: ground design in subject, make one justified aesthetic risk, plan tokens, then build
- Pair with: impeccable for execution and polish, design-consultation for durable system docs

### impeccable
- Path: _skill-downloads/impeccable/plugin/skills/impeccable/SKILL.md
- Source repo: pbakaus/impeccable
- Use for: full frontend craft, critique, audit, animate, layout, typeset, and polish
- Call when: improving UI quality, fixing hierarchy, motion, spacing, or responsive behavior
- Key behavior: refine preserves existing identity unless redesign is requested; verify in bounded passes
- Pair with: frontend-design for direction, review-pr for change review, karpathy-guidelines for minimal edits

### design-consultation
- Path: _skill-downloads/gstack/design-consultation/SKILL.md
- Source repo: garrytan/gstack
- Use for: creating DESIGN.md, brand language, typography, color, spacing, motion system
- Call when: starting a project with no design system, or resetting the visual language
- Key behavior: propose a complete system and generate preview tokens
- Pair with: frontend-design for page-level intent, design-review for critique

### design-review
- Path: _skill-downloads/gstack/design-review/SKILL.md
- Source repo: garrytan/gstack
- Use for: design review of existing UI or proposed changes
- Call when: checking whether a design matches the intended system or brief
- Key behavior: review taste, hierarchy, consistency, and polish
- Pair with: review-pr for code-level review

### taste-skill
- Path: skills/taste-skill/skills/taste-skill/SKILL.md
- Source repo: leonxlnx/taste-skill
- Use for: landing pages, portfolios, redesigns, and anti-slop frontend decisions
- Call when: the brief is vague or the UI feels templated
- Key behavior: infer the page kind, audience, and vibe first; set variance, motion, and density dials
- Pair with: frontend-design for visual execution, animation-vocabulary for motion naming

### apple-design
- Path: _skill-downloads/skills/skills/apple-design/SKILL.md
- Source repo: emilkowalski/skills
- Use for: Apple-like layout and interaction taste
- Call when: the target feels should be calm, precise, and native
- Key behavior: use restraint, spacing, and motion discipline
- Pair with: animation-vocabulary for precise effect names

### animation-vocabulary
- Path: _skill-downloads/skills/skills/animation-vocabulary/SKILL.md
- Source repo: emilkowalski/skills
- Use for: naming motion effects from user descriptions
- Call when: someone says “the bouncy popover thing” and you need the exact term
- Key behavior: map sensation to glossary term and disambiguate close options
- Pair with: impeccable or frontend-design when implementing the named effect

### karpathy-guidelines
- Path: _skill-downloads/andrej-karpathy-skills/skills/karpathy-guidelines/SKILL.md
- Source repo: multica-ai/andrej-karpathy-skills
- Use for: writing, reviewing, and refactoring code with surgical discipline
- Call when: you are about to edit code and want to avoid overbuilding
- Key behavior: state assumptions, prefer simplest working change, avoid unrelated cleanup
- Pair with: refactor-safely, review-delta, verification-before-completion

### systematic-debugging
- Path: _skill-downloads/superpowers/skills/systematic-debugging/SKILL.md
- Source repo: obra/superpowers
- Use for: bugs, failing tests, build failures, and unexpected behavior
- Call when: something is broken and you do not yet know why
- Key behavior: find root cause first; no fixes without investigation
- Pair with: review-delta to inspect recent changes

### writing-plans
- Path: _skill-downloads/superpowers/skills/writing-plans/SKILL.md
- Source repo: obra/superpowers
- Use for: breaking a feature spec into executable tasks
- Call when: work is multi-step and should be predictable and reviewable
- Key behavior: write file-level tasks, include test commands, avoid placeholders
- Pair with: brainstorming for initial direction

### brainstorming
- Path: _skill-downloads/superpowers/skills/brainstorming/SKILL.md
- Source repo: obra/superpowers
- Use for: exploring options before locking a plan or design
- Call when: requirements are ambiguous or multiple approaches are possible
- Key behavior: generate options, tradeoffs, and a recommended direction
- Pair with: writing-plans to turn the chosen direction into tasks

### verification-before-completion
- Path: _skill-downloads/superpowers/skills/verification-before-completion/SKILL.md
- Source repo: obra/superpowers
- Use for: final checks before claiming done, fixed, or passing
- Call when: you are about to commit, ship, or report completion
- Key behavior: run fresh verification, read output, only then claim success
- Pair with: karpathy-guidelines to keep the change minimal

### review-pr
- Path: _skill-downloads/code-review-graph/skills/review-pr/SKILL.md
- Source repo: tirth8205/code-review-graph
- Use for: full PR review with structural context and blast radius
- Call when: reviewing a branch against main
- Key behavior: inspect changed files, callers, tests, and risk areas
- Pair with: review-delta for smaller scope or incremental review

### review-delta
- Path: _skill-downloads/code-review-graph/skills/review-delta/SKILL.md
- Source repo: tirth8205/code-review-graph
- Use for: token-efficient review of the latest changes only
- Call when: making frequent small edits and need fast feedback
- Key behavior: review changed nodes plus immediate blast radius
- Pair with: karpathy-guidelines for minimal change hygiene

### refactor-safely
- Path: _skill-downloads/code-review-graph/skills/refactor-safely/SKILL.md
- Source repo: tirth8205/code-review-graph
- Use for: improving code structure without changing behavior
- Call when: cleanup is needed and behavior must stay stable
- Key behavior: small steps, preserve behavior, verify after each step
- Pair with: review-delta to confirm no unexpected impact

## Repositories installed

| Repo | Status | Best-fit skills |
| --- | --- | --- |
| leonxlnx/taste-skill | installed | taste-skill |
| pbakaus/impeccable | installed | impeccable |
| emilkowalski/skills | installed | apple-design, animation-vocabulary |
| anthropics/claude-code | installed | frontend-design |
| tirth8205/code-review-graph | installed | review-pr, review-delta, refactor-safely |
| garrytan/gstack | installed | gstack router, autoplan, design-consultation, design-review |
| obra/superpowers | installed | brainstorming, systematic-debugging, writing-plans, verification-before-completion |
| DietrichGebert/ponytail | installed | ponytail skills |
| multica-ai/andrej-karpathy-skills | installed | karpathy-guidelines |

## Missing expected paths

- nthropics/claude-code/tree/main/plugins/security-guidance: security-guidance skill was not present in the downloaded plugin tree.
- This means no dedicated **security-guidance** entry is included until the path or package is located.

## Maintenance rule

- Update this file when you add a skill, remove a skill, or discover a better task mapping.
- Prefer adding one new mapping over rewriting the whole table.
