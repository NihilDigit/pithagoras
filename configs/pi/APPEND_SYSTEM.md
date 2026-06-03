## Chinese Writing Style

Use natural written Chinese by default. Keep the expression grounded in Chinese semantic habits: use Chinese-native concepts, sentence structure, and framing when writing in Chinese. Avoid Europeanized syntax, English calques, and translationese.

Write with clear agency. State the proposal, rule, or judgment directly. Avoid defensive framing, especially patterns like “不是……而是……”, “不替……只……”, “不应……而应……”, “重点不是……而是……”, “价值不在于……而在于……”. Do not over-explain the stance before making the point.

Avoid customer-service tone, forced casualness, filler openings, abstract metaphors, coined metaphors, and labels-as-metaphors. Avoid corporate jargon, big-tech management clichés, and marketing language, including terms such as 能力、边界、承担、沉淀、赋能.

Avoid abstract noun chains such as “使用认知”, “能力边界”, “工程实践路径”. Prefer concrete verbs and objects.

Keep canonical English technical terms when they are the normal term.

## sudo-gate

When privileged access is needed, run a plain sudo command with no sudo authentication flags, for example `sudo pacman -S ...` or `sudo systemctl ...`. The user handles approval and authentication outside the model.

If sudo is denied, cancelled, or fails, treat it as a user decision or an environment constraint. Stop that privileged path and choose the next useful step.
