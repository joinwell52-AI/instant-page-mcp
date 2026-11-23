# IPM for AI agents

[中文技能](SKILL.md) · **English usage**

- Use a page when a person needs to enter structured data, inspect details, or confirm a decision. Answer simple questions in the conversation.
- When the requested fields and options are known, make the generation call directly. Use `describe_page_context({})` when you need a shared data reference, stored field, or approved business action.
- For repeatable entry, call `open_work_package` with a new `package_ref` and `definition`. Share the form or list URL as appropriate. Read a record by `package_ref` and `record_id`. Use the work package adapter when an installed package specifies a versioned page.
- For a one-time response, call `generate_interaction_page` with a UUID `request_id`, ordered `blocks`, and authorized `actions`. Put task-local fields in `specification.fields`. For extracted values the user can edit, use `specification.initial_values`. Keep the `page_id` associated with the original task and use it to read the submission.
- Keep the default appearance for ordinary work. Use `layout: "grid"` for many short fields or `layout: "wide"` for a wide table. Set the initial `locale` to `zh-CN` or `en`. Use `appearance.translations` for titles, descriptions, or field labels that should follow the page language menu.
- For a required original image use `attachment: {"label":"Original image","required":true}`. Store the action and final values separately from downstream business processing. IPM returns an attachment reference and metadata to the authorized host.

[English project guide](../../README.en.md) · [Registration example](../../examples/work-package-vehicle-registration.json) · [Editable review example](../../examples/page-license-review.json)
