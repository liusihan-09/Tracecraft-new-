---
name: wireframe-design
description: Generate wireframe designs in SVG format for UI/UX layouts. Analyze requirements and provide multiple wireframe scheme options with basic layout and functionality visualization. Use for wireframe design for web/mobile interfaces, layout sketches for apps/pages, basic structure visualization without styling, or multiple design scheme comparisons. Supports iOS, Android, and Web platforms. Outputs to fixed path /wireframe-design. Depends on ui-ux-pro-max skill or frontend-design skill for design specifications.
---

# Wireframe Design Skill

Generate professional wireframe designs that focus on layout structure and functionality, without visual styling.

## Quick Start

1. **Analyze requirements** - Identify product type, platform, and core features
2. **Propose schemes** - Present 2-3 design approaches with pros/cons
3. **Search specifications** - Use `/ui-ux-pro-max` to find design guidelines
4. **Generate wireframes** - Create SVG files for each screen
5. **Document design** - Write README.md with layout explanations

**Output directory:** `/wireframe-design` (fixed path in project root or temp/)

## When to Use This Skill

Trigger this skill when user asks for:
- Wireframe designs for web/mobile interfaces
- Layout sketches without styling
- Basic UI structure visualization
- Multiple design scheme comparisons
- Screen mockups for development reference

**Do NOT use** for: High-fidelity visual designs, styled UI components, branding work.

## Workflow

### Step 1: Requirement Analysis

Extract key information:
- **Platform**: iOS, Android, Web, or Cross-platform
- **Product type**: Login, dashboard, form, list, detail page, etc.
- **Core features**: Required components and interactions
- **Constraints**: Screen sizes, navigation patterns, platform guidelines

### Step 2: Design Scheme Proposals

Present **2-3 different approaches** with:

**Scheme 1: [Name]**
- Layout: [describe arrangement]
- Pros: [advantages]
- Cons: [disadvantages]
- Best for: [use cases]

**Scheme 2: [Name]**
- Layout: [describe arrangement]
- Pros: [advantages]
- Cons: [disadvantages]
- Best for: [use cases]

Ask user to choose or combine schemes.

### Step 3: Search Design Specifications

Use `/ui-ux-pro-max` skill to find platform-specific guidelines:

```bash
# For iOS designs
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "ios mobile layout" --stack html-tailwind

# For component-specific
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<component-type>" --domain ux

# For typography
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<style-keyword>" --domain typography
```

**Fallback:** If `/ui-ux-pro-max` unavailable, use `/frontend-design`.

### Step 4: Generate SVG Wireframes

**CRITICAL: Minimal Wireframe Style - Pure Lines Only**

```xml
<!-- Use ONLY these SVG styles -->
<style>
  .stroke { fill: none; stroke: #333; stroke-width: 1.5; }
  .stroke-thin { fill: none; stroke: #999; stroke-width: 1; }
  .text { font-family: sans-serif; font-size: 14px; fill: #666; }
  .text-title { font-size: 18px; font-weight: bold; fill: #333; }
</style>
```

**Wireframe Rules:**
- **NO fills** - Remove all `fill="white"`, `fill="#f5f5f5"`, etc. Use `fill="none"` only
- **NO colors** - Only #333 (black) and #999 (gray) for strokes
- **NO icons** - Use text labels like [图标], [头像], [按钮] instead
- **NO decorations** - Remove circles, emojis, fancy shapes
- **Simple rectangles** - Use `<rect>` for all UI elements
- **Thin lines** - 1px for separators, 1.5px for main borders
- **Text labels** - Label everything clearly in Chinese

**Minimal SVG Template:**
```svg
<svg width="360" height="640" viewBox="0 0 360 640" xmlns="http://www.w3.org/2000/svg">
  <style>
    .stroke { fill: none; stroke: #333; stroke-width: 1.5; }
    .stroke-thin { fill: none; stroke: #999; stroke-width: 1; }
    .text { font-family: sans-serif; font-size: 14px; fill: #666; }
    .text-title { font-size: 18px; font-weight: bold; fill: #333; }
  </style>

  <!-- Screen border -->
  <rect class="stroke" x="0" y="0" width="360" height="640"/>

  <!-- Status bar -->
  <line class="stroke-thin" x1="0" y1="24" x2="360" y2="24"/>
  <text class="text" x="16" y="18">9:41</text>

  <!-- Content areas as rectangles -->
  <rect class="stroke" x="16" y="60" width="328" height="56"/>
  <text class="text" x="32" y="95">[按钮文字]</text>
</svg>
```

**File naming:** `01-screen-name.svg`, `02-screen-name.svg` (numbered for order)

### Step 5: Document Output

Create **README.md** with:
- File list and screen descriptions
- Layout structure explanation
- Component breakdown
- Interaction flow
- Platform-specific notes

**For multiple schemes**, create `SCHEMES.md` comparing approaches.

## Output Format

```
/wireframe-design/
├── 01-main-screen.svg
├── 02-secondary-screen.svg
├── README.md (required)
└── SCHEMES.md (if multiple schemes)
```

## Common Patterns

See [patterns.md](references/patterns.md) for:
- Navigation patterns (tabs, headers, drawers)
- Component layouts (forms, lists, cards)
- Platform-specific elements (iOS bars, Android FAB)
- Responsive breakpoints

## Reference Case Study

See [case-study.md](references/case-study.md) for complete example:
- **Project**: iOS login interface with 5 auth methods
- **Schemes**: Card-based vs Step-based layouts
- **Output**: 7 SVG wireframes
- **Process**: From requirement to final delivery

## Best Practices

1. **Keep it simple** - Wireframes should be minimal and clear
2. **Focus on structure** - Show layout, not visual design
3. **Number screens** - Use 01-, 02-, 03- prefix for flow clarity
4. **Label everything** - Use text labels to explain components
5. **Show interactions** - Indicate touch targets and clickable areas
6. **Think responsive** - Consider different screen sizes
7. **Follow platform conventions** - Respect iOS/Android/Web patterns
8. **Document decisions** - Explain why layouts are arranged this way

## Troubleshooting

**Issue**: SVG looks too detailed
- **Fix**: Remove colors, shadows, gradients; simplify icons

**Issue**: File size too large
- **Fix**: Use simpler paths, reduce detail level

**Issue**: Layout doesn't match platform
- **Fix**: Search platform-specific guidelines using ui-ux-pro-max

## Dependencies

- **Primary**: `/ui-ux-pro-max` for design specifications
- **Fallback**: `/frontend-design` if ui-ux-pro-max unavailable
- **Tools**: Python 3, SVG viewer/browser
