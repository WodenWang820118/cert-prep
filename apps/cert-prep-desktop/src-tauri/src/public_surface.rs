//! Allowlist of the items other crates can name. `unreachable_pub` rejects a
//! `pub` item that is not reachable; this test rejects a reachable one that
//! was not listed.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Ident(String),
    Sym(char),
}

#[test]
fn crate_public_items_stay_on_the_allowlist() {
    let found = crate_public_items();
    let allowed: BTreeSet<String> = [
        "BackendConfig",
        "BackendConfig::base_url",
        "BackendConfig::token",
        "BackendState",
        "DesktopRuntimeInstallation",
        "DesktopRuntimeInstallation::completed",
        "DesktopRuntimeInstallation::created_at",
        "DesktopRuntimeInstallation::detail",
        "DesktopRuntimeInstallation::error",
        "DesktopRuntimeInstallation::id",
        "DesktopRuntimeInstallation::kind",
        "DesktopRuntimeInstallation::model",
        "DesktopRuntimeInstallation::provider",
        "DesktopRuntimeInstallation::status",
        "DesktopRuntimeInstallation::total",
        "DesktopRuntimeInstallation::updated_at",
        "DesktopRuntimeStatus",
        "DesktopRuntimeStatus::available",
        "DesktopRuntimeStatus::base_url",
        "DesktopRuntimeStatus::completed",
        "DesktopRuntimeStatus::detail",
        "DesktopRuntimeStatus::error",
        "DesktopRuntimeStatus::installed_path",
        "DesktopRuntimeStatus::job_id",
        "DesktopRuntimeStatus::kind",
        "DesktopRuntimeStatus::label",
        "DesktopRuntimeStatus::running",
        "DesktopRuntimeStatus::status",
        "DesktopRuntimeStatus::token",
        "DesktopRuntimeStatus::total",
        "DesktopRuntimeStatus::unavailable_reason",
        "DesktopRuntimeStatus::version",
        "build_backend_config",
        "run",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();

    assert_eq!(found, allowed);
}

fn crate_public_items() -> BTreeSet<String> {
    let lib = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("lib.rs");
    let mut items = BTreeSet::new();
    scan_file(&lib, true, "", &mut items, &BTreeMap::new());
    let types = export_idents(&items);
    for file in module_files(&lib) {
        scan_file(&file, false, "", &mut items, &types);
    }
    items
}

fn export_idents(items: &BTreeSet<String>) -> BTreeMap<String, String> {
    let mut idents = BTreeMap::new();
    for path in items {
        let ident = path.rsplit("::").next().expect("export name").to_string();
        if let Some(previous) = idents.insert(ident.clone(), path.clone()) {
            panic!("public items share a name ({ident}): {previous} and {path}");
        }
    }
    idents
}

fn module_files(lib: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![lib.to_path_buf()];
    while let Some(file) = pending.pop() {
        if files.iter().any(|seen: &PathBuf| seen == &file) {
            continue;
        }
        let tokens = tokenize_file(&file);
        let mut index = 0;
        while index < tokens.len() {
            let (configured, next) = skip_attributes(&tokens, index);
            index = next;
            if ident_at(&tokens, index) == Some("mod") {
                let name = ident_at(&tokens, index + 1).unwrap_or("").to_string();
                if is_sym(&tokens, index + 2, ';') {
                    if let Some(child) = resolve_module(&file, &name, configured) {
                        pending.push(child);
                    }
                }
            }
            let before = index;
            index = skip_item(&tokens, index);
            if index == before {
                index += 1;
            }
        }
        files.push(file);
    }
    files
}

fn scan_file(
    file: &Path,
    export: bool,
    prefix: &str,
    items: &mut BTreeSet<String>,
    types: &BTreeMap<String, String>,
) {
    let tokens = tokenize_file(file);
    scan_tokens(&tokens, 0, tokens.len(), export, prefix, items, types, file);
}

fn scan_tokens(
    tokens: &[Tok],
    mut index: usize,
    end: usize,
    export: bool,
    prefix: &str,
    items: &mut BTreeSet<String>,
    types: &BTreeMap<String, String>,
    file: &Path,
) {
    while index < end {
        let (configured, next) = skip_attributes(tokens, index);
        index = next;
        if index >= end {
            break;
        }
        if is_sym(tokens, index, ';') {
            index += 1;
            continue;
        }
        let (public, after_visibility) = visibility(tokens, index);
        index = after_visibility;
        let mut keyword_at = index;
        keyword_at = skip_qualifiers(tokens, keyword_at);
        let keyword = ident_at(tokens, keyword_at).unwrap_or("");
        if keyword.is_empty() {
            index += 1;
            continue;
        }
        if keyword == "mod" && public && export {
            let name = ident_at(tokens, keyword_at + 1).unwrap_or("");
            if name.is_empty() {
                items.insert("(unparsed pub mod)".to_string());
            } else {
                items.insert(join_path(prefix, name));
                let child_prefix = format!("{}::", join_path(prefix, name));
                if is_sym(tokens, keyword_at + 2, ';') {
                    if let Some(child) = resolve_module(file, name, configured) {
                        scan_file(&child, true, &child_prefix, items, types);
                    }
                    index = skip_item(tokens, keyword_at);
                    continue;
                }
                if is_sym(tokens, keyword_at + 2, '{') {
                    let close = matching_close(tokens, keyword_at + 2, '{', '}');
                    scan_tokens(
                        tokens,
                        keyword_at + 3,
                        close,
                        true,
                        &child_prefix,
                        items,
                        types,
                        file,
                    );
                    index = close + 1;
                    continue;
                }
            }
        }
        if keyword == "use" && public && export {
            match parse_use_tree(tokens, keyword_at + 1) {
                Ok((names, _)) => {
                    for name in names {
                        items.insert(join_path(prefix, &name));
                    }
                }
                Err(error) => {
                    items.insert(format!("(unparsed use: {error})"));
                }
            }
            index = skip_item(tokens, keyword_at);
            continue;
        }
        if matches!(
            keyword,
            "struct" | "enum" | "union" | "trait" | "type" | "fn" | "const" | "static"
        ) && public
            && export
        {
            if let Some(name) = ident_at(tokens, keyword_at + 1) {
                items.insert(join_path(prefix, name));
            } else {
                items.insert(format!("(unparsed pub {keyword})"));
            }
        }
        if keyword == "struct" || keyword == "enum" || keyword == "union" {
            if let Some(name) = ident_at(tokens, keyword_at + 1) {
                if let Some(path) = types.get(name) {
                    collect_type_members(tokens, keyword_at, keyword, path, items);
                }
            }
        }
        if keyword == "impl" {
            if let Some((target, open)) = impl_target(tokens, keyword_at) {
                if let Some(path) = types.get(&target) {
                    let close = matching_close(tokens, open, '{', '}');
                    collect_impl_members(tokens, open + 1, close, path, items);
                }
            }
        }
        if public
            && export
            && !matches!(
                keyword,
                "struct"
                    | "enum"
                    | "union"
                    | "trait"
                    | "type"
                    | "fn"
                    | "const"
                    | "static"
                    | "use"
                    | "mod"
                    | "impl"
            )
        {
            items.insert(format!("(unparsed pub {keyword})"));
        }
        let before = index;
        index = skip_item(tokens, keyword_at);
        if index <= before {
            index = before + 1;
        }
    }
}

fn collect_type_members(
    tokens: &[Tok],
    keyword_at: usize,
    keyword: &str,
    path: &str,
    items: &mut BTreeSet<String>,
) {
    let mut index = keyword_at + 1;
    if ident_at(tokens, index).is_some() {
        index += 1;
    }
    index = skip_generics_and_where(tokens, index);
    if keyword == "struct" && is_sym(tokens, index, '(') {
        let close = matching_close(tokens, index, '(', ')');
        collect_tuple_fields(tokens, index + 1, close, path, items);
        return;
    }
    if is_sym(tokens, index, '{') && (keyword == "struct" || keyword == "union") {
        let close = matching_close(tokens, index, '{', '}');
        collect_brace_fields(tokens, index + 1, close, path, items);
        return;
    }
    if keyword == "enum" && is_sym(tokens, index, '{') {
        let close = matching_close(tokens, index, '{', '}');
        collect_enum_variants(tokens, index + 1, close, path, items);
    }
}

fn collect_brace_fields(
    tokens: &[Tok],
    mut index: usize,
    end: usize,
    path: &str,
    items: &mut BTreeSet<String>,
) {
    while index < end {
        let (_, next) = skip_attributes(tokens, index);
        index = next;
        if index >= end {
            break;
        }
        let (public, after) = visibility(tokens, index);
        index = after;
        if public {
            if let Some(name) = ident_at(tokens, index) {
                items.insert(format!("{path}::{name}"));
                index += 1;
            }
        }
        index = skip_to_comma(tokens, index, end);
    }
}

fn collect_tuple_fields(
    tokens: &[Tok],
    mut index: usize,
    end: usize,
    path: &str,
    items: &mut BTreeSet<String>,
) {
    let mut field = 0usize;
    while index < end {
        let (_, next) = skip_attributes(tokens, index);
        index = next;
        if index >= end {
            break;
        }
        let (public, after) = visibility(tokens, index);
        if public {
            items.insert(format!("{path}::{field}"));
        }
        index = skip_to_comma(tokens, after, end);
        field += 1;
    }
}

fn collect_enum_variants(
    tokens: &[Tok],
    mut index: usize,
    end: usize,
    path: &str,
    items: &mut BTreeSet<String>,
) {
    while index < end {
        let (_, next) = skip_attributes(tokens, index);
        index = next;
        if index >= end {
            break;
        }
        if let Some(name) = ident_at(tokens, index) {
            items.insert(format!("{path}::{name}"));
            index += 1;
            if is_sym(tokens, index, '(') || is_sym(tokens, index, '{') {
                let open = if is_sym(tokens, index, '(') { '(' } else { '{' };
                let close_char = if open == '(' { ')' } else { '}' };
                index = matching_close(tokens, index, open, close_char) + 1;
            } else if is_sym(tokens, index, '=') {
                index = skip_to_comma(tokens, index, end);
                continue;
            }
            if is_sym(tokens, index, ',') {
                index += 1;
            }
        } else {
            index += 1;
        }
    }
}

fn collect_impl_members(
    tokens: &[Tok],
    mut index: usize,
    end: usize,
    path: &str,
    items: &mut BTreeSet<String>,
) {
    while index < end {
        let (_, next) = skip_attributes(tokens, index);
        index = next;
        if index >= end {
            break;
        }
        let (public, after) = visibility(tokens, index);
        let keyword_at = skip_qualifiers(tokens, after);
        let keyword = ident_at(tokens, keyword_at).unwrap_or("");
        if public && matches!(keyword, "fn" | "const" | "type") {
            if let Some(name) = ident_at(tokens, keyword_at + 1) {
                if keyword != "const" || ident_at(tokens, keyword_at + 1) != Some("fn") {
                    items.insert(format!("{path}::{name}"));
                }
            }
        }
        let before = keyword_at;
        index = skip_item(tokens, keyword_at);
        if index <= before {
            index = before + 1;
        }
    }
}

fn impl_target(tokens: &[Tok], mut index: usize) -> Option<(String, usize)> {
    index += 1;
    if is_sym(tokens, index, '<') {
        index = matching_close(tokens, index, '<', '>') + 1;
    }
    let mut target = String::new();
    let mut after_for = false;
    let mut angles = 0i32;
    let mut parens = 0i32;
    while index < tokens.len() {
        match &tokens[index] {
            Tok::Sym('<') if parens == 0 => angles += 1,
            Tok::Sym('>') if parens == 0 && angles > 0 => angles -= 1,
            Tok::Sym('(') => parens += 1,
            Tok::Sym(')') => parens -= 1,
            Tok::Sym('{') if angles == 0 && parens == 0 => {
                if target.is_empty() {
                    return None;
                }
                return Some((target, index));
            }
            Tok::Ident(word) if angles == 0 && parens == 0 => {
                if word == "where" {
                    while index < tokens.len() && !is_sym(tokens, index, '{') {
                        index += 1;
                    }
                    continue;
                }
                if word == "for" {
                    after_for = true;
                    target.clear();
                } else if after_for || target.is_empty() {
                    target.clone_from(word);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn skip_generics_and_where(tokens: &[Tok], mut index: usize) -> usize {
    if is_sym(tokens, index, '<') {
        index = matching_close(tokens, index, '<', '>') + 1;
    }
    if ident_at(tokens, index) == Some("where") {
        while index < tokens.len()
            && !is_sym(tokens, index, '{')
            && !is_sym(tokens, index, '(')
            && !is_sym(tokens, index, ';')
        {
            index += 1;
        }
    }
    index
}

fn skip_to_comma(tokens: &[Tok], mut index: usize, end: usize) -> usize {
    let mut braces = 0i32;
    let mut parens = 0i32;
    let mut brackets = 0i32;
    let mut angles = 0i32;
    while index < end {
        match tokens[index] {
            Tok::Sym('{') => braces += 1,
            Tok::Sym('}') => braces -= 1,
            Tok::Sym('(') => parens += 1,
            Tok::Sym(')') => parens -= 1,
            Tok::Sym('[') => brackets += 1,
            Tok::Sym(']') => brackets -= 1,
            Tok::Sym('<') if parens == 0 && braces == 0 && brackets == 0 => angles += 1,
            Tok::Sym('>') if angles > 0 => angles -= 1,
            Tok::Sym(',') if braces == 0 && parens == 0 && brackets == 0 && angles == 0 => {
                return index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    index
}

fn visibility(tokens: &[Tok], index: usize) -> (bool, usize) {
    if ident_at(tokens, index) != Some("pub") {
        return (false, index);
    }
    if is_sym(tokens, index + 1, '(') {
        return (false, matching_close(tokens, index + 1, '(', ')') + 1);
    }
    (true, index + 1)
}

fn skip_qualifiers(tokens: &[Tok], mut index: usize) -> usize {
    loop {
        match ident_at(tokens, index) {
            Some("async" | "unsafe" | "extern") => index += 1,
            Some("const") if ident_at(tokens, index + 1) == Some("fn") => index += 1,
            _ => return index,
        }
    }
}

fn skip_attributes(tokens: &[Tok], mut index: usize) -> (bool, usize) {
    let mut configured = false;
    while is_sym(tokens, index, '#') {
        let mut cursor = index + 1;
        if is_sym(tokens, cursor, '!') {
            cursor += 1;
        }
        if !is_sym(tokens, cursor, '[') {
            break;
        }
        let close = matching_close(tokens, cursor, '[', ']');
        if tokens[index + 1..close]
            .iter()
            .any(|token| matches!(token, Tok::Ident(word) if word == "cfg"))
        {
            configured = true;
        }
        index = close + 1;
    }
    (configured, index)
}

fn skip_item(tokens: &[Tok], mut index: usize) -> usize {
    let mut braces = 0i32;
    let mut parens = 0i32;
    let mut brackets = 0i32;
    let mut started = false;
    while index < tokens.len() {
        match tokens[index] {
            Tok::Sym('{') => {
                braces += 1;
                started = true;
            }
            Tok::Sym('}') => {
                braces -= 1;
                if started && braces == 0 && parens == 0 && brackets == 0 {
                    return index + 1;
                }
            }
            Tok::Sym('(') => parens += 1,
            Tok::Sym(')') => parens -= 1,
            Tok::Sym('[') => brackets += 1,
            Tok::Sym(']') => brackets -= 1,
            Tok::Sym(';') if braces == 0 && parens == 0 && brackets == 0 => return index + 1,
            _ => {}
        }
        index += 1;
    }
    index
}

fn matching_close(tokens: &[Tok], open: usize, open_char: char, close_char: char) -> usize {
    let mut depth = 0i32;
    let mut index = open;
    while index < tokens.len() {
        if is_sym(tokens, index, open_char) {
            depth += 1;
        } else if is_sym(tokens, index, close_char) {
            depth -= 1;
            if depth == 0 {
                return index;
            }
        }
        index += 1;
    }
    tokens.len().saturating_sub(1)
}

fn parse_use_tree(tokens: &[Tok], index: usize) -> Result<(Vec<String>, usize), String> {
    if is_sym(tokens, index, '*') {
        return Err("glob".into());
    }
    if is_sym(tokens, index, '{') {
        return parse_use_group(tokens, index);
    }
    let (mut segments, index) = parse_path(tokens, index);
    if segments.is_empty() {
        return Err("empty path".into());
    }
    if is_colon2(tokens, index) && is_sym(tokens, index + 2, '*') {
        return Err("glob".into());
    }
    if is_colon2(tokens, index) && is_sym(tokens, index + 2, '{') {
        return parse_use_group(tokens, index + 2);
    }
    if ident_at(tokens, index) == Some("as") {
        let alias = ident_at(tokens, index + 1).ok_or("alias")?.to_string();
        return Ok((vec![alias], index + 2));
    }
    Ok((vec![segments.pop().expect("path segment")], index))
}

fn parse_use_group(tokens: &[Tok], mut index: usize) -> Result<(Vec<String>, usize), String> {
    index += 1;
    let mut names = Vec::new();
    while index < tokens.len() && !is_sym(tokens, index, '}') {
        if is_sym(tokens, index, ',') {
            index += 1;
            continue;
        }
        let (inner, next) = parse_use_tree(tokens, index)?;
        names.extend(inner);
        index = next;
        if is_sym(tokens, index, ',') {
            index += 1;
        }
    }
    if is_sym(tokens, index, '}') {
        index += 1;
    }
    Ok((names, index))
}

fn parse_path(tokens: &[Tok], mut index: usize) -> (Vec<String>, usize) {
    if is_colon2(tokens, index) {
        index += 2;
    }
    let mut segments = Vec::new();
    loop {
        let Some(segment) = ident_at(tokens, index) else {
            break;
        };
        segments.push(segment.to_string());
        index += 1;
        if is_colon2(tokens, index) && ident_at(tokens, index + 2).is_some() {
            index += 2;
            continue;
        }
        break;
    }
    (segments, index)
}

fn resolve_module(parent: &Path, name: &str, configured: bool) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    match resolve_module_path(parent, name) {
        Some(path) => Some(path),
        None if configured => None,
        None => panic!("missing module {name} declared by {}", parent.display()),
    }
}

fn resolve_module_path(parent: &Path, name: &str) -> Option<PathBuf> {
    let directory = match parent.file_name().and_then(|file_name| file_name.to_str()) {
        Some("lib.rs" | "main.rs" | "mod.rs") => parent.parent()?.to_path_buf(),
        Some(file_name) => parent.parent()?.join(file_name.trim_end_matches(".rs")),
        None => return None,
    };
    let flat = directory.join(format!("{name}.rs"));
    let nested = directory.join(name).join("mod.rs");
    match (flat.is_file(), nested.is_file()) {
        (true, false) => Some(flat),
        (false, true) => Some(nested),
        (false, false) => None,
        (true, true) => panic!(
            "module {name} is both {} and {}",
            flat.display(),
            nested.display()
        ),
    }
}

fn join_path(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}{name}")
    }
}

fn ident_at<'a>(tokens: &'a [Tok], index: usize) -> Option<&'a str> {
    match tokens.get(index) {
        Some(Tok::Ident(name)) => Some(name.as_str()),
        _ => None,
    }
}

fn is_sym(tokens: &[Tok], index: usize, symbol: char) -> bool {
    matches!(tokens.get(index), Some(Tok::Sym(found)) if *found == symbol)
}

fn is_colon2(tokens: &[Tok], index: usize) -> bool {
    is_sym(tokens, index, ':') && is_sym(tokens, index + 1, ':')
}

fn tokenize_file(file: &Path) -> Vec<Tok> {
    let source = fs::read_to_string(file).unwrap_or_else(|error| {
        panic!("read {}: {error}", file.display());
    });
    let tokens = tokenize(&mask_non_code(&source));
    assert_balanced(&tokens, file);
    tokens
}

fn assert_balanced(tokens: &[Tok], file: &Path) {
    let mut braces = 0i32;
    let mut parens = 0i32;
    let mut brackets = 0i32;
    for token in tokens {
        match token {
            Tok::Sym('{') => braces += 1,
            Tok::Sym('}') => braces -= 1,
            Tok::Sym('(') => parens += 1,
            Tok::Sym(')') => parens -= 1,
            Tok::Sym('[') => brackets += 1,
            Tok::Sym(']') => brackets -= 1,
            _ => {}
        }
        if braces < 0 || parens < 0 || brackets < 0 {
            panic!("unbalanced delimiter in {}", file.display());
        }
    }
    if braces != 0 || parens != 0 || brackets != 0 {
        panic!(
            "unbalanced delimiter in {} (braces {braces}, parens {parens}, brackets {brackets})",
            file.display()
        );
    }
}

fn tokenize(source: &str) -> Vec<Tok> {
    let chars: Vec<char> = source.chars().collect();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        if current.is_whitespace() {
            index += 1;
            continue;
        }
        if current == '_' || current.is_ascii_alphabetic() {
            let start = index;
            index += 1;
            while index < chars.len()
                && (chars[index] == '_' || chars[index].is_ascii_alphanumeric())
            {
                index += 1;
            }
            tokens.push(Tok::Ident(chars[start..index].iter().collect()));
            continue;
        }
        if matches!(
            current,
            '(' | ')' | '{' | '}' | '[' | ']' | ';' | ',' | ':' | '<' | '>' | '#'
        ) {
            tokens.push(Tok::Sym(current));
        }
        index += 1;
    }
    tokens
}

fn mask_non_code(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut masked = chars.clone();
    let mut index = 0;
    while index < chars.len() {
        if let Some(end) = consume_trivia(&chars, index) {
            while index < end {
                masked[index] = ' ';
                index += 1;
            }
            continue;
        }
        index += 1;
    }
    masked.into_iter().collect()
}

fn consume_trivia(chars: &[char], index: usize) -> Option<usize> {
    let current = chars[index];
    let next = chars.get(index + 1).copied();
    if current == '/' && next == Some('/') {
        let mut end = index;
        while end < chars.len() && chars[end] != '\n' {
            end += 1;
        }
        return Some(end);
    }
    if current == '/' && next == Some('*') {
        return Some(consume_block_comment(chars, index));
    }
    if current == 'b' && next == Some('\'') {
        return Some(consume_tick(chars, index + 1));
    }
    if current == 'b' && next == Some('"') {
        return Some(consume_quoted(chars, index + 1));
    }
    if current == 'b' && next == Some('r') {
        if let Some(end) = consume_raw(chars, index + 1) {
            return Some(end);
        }
    }
    if current == 'c' && next == Some('"') {
        return Some(consume_quoted(chars, index + 1));
    }
    if current == 'r' {
        if let Some(end) = consume_raw(chars, index) {
            return Some(end);
        }
    }
    if current == '"' {
        return Some(consume_quoted(chars, index));
    }
    if current == '\'' {
        return Some(consume_tick(chars, index));
    }
    None
}

fn consume_block_comment(chars: &[char], index: usize) -> usize {
    let mut cursor = index + 2;
    let mut depth = 1i32;
    while cursor + 1 < chars.len() && depth > 0 {
        if chars[cursor] == '/' && chars[cursor + 1] == '*' {
            depth += 1;
            cursor += 2;
            continue;
        }
        if chars[cursor] == '*' && chars[cursor + 1] == '/' {
            depth -= 1;
            cursor += 2;
            continue;
        }
        cursor += 1;
    }
    cursor
}

fn consume_raw(chars: &[char], index: usize) -> Option<usize> {
    if chars.get(index) != Some(&'r') {
        return None;
    }
    let mut cursor = index + 1;
    let mut hashes = 0usize;
    while chars.get(cursor) == Some(&'#') {
        hashes += 1;
        cursor += 1;
    }
    if chars.get(cursor) != Some(&'"') {
        return None;
    }
    cursor += 1;
    while cursor < chars.len() {
        if chars[cursor] == '"' && has_hashes(chars, cursor + 1, hashes) {
            return Some(cursor + 1 + hashes);
        }
        cursor += 1;
    }
    Some(chars.len())
}

fn has_hashes(chars: &[char], index: usize, hashes: usize) -> bool {
    (0..hashes).all(|offset| chars.get(index + offset) == Some(&'#'))
}

fn consume_quoted(chars: &[char], index: usize) -> usize {
    let mut cursor = index + 1;
    while cursor < chars.len() {
        if chars[cursor] == '\\' {
            cursor = (cursor + 2).min(chars.len());
            continue;
        }
        if chars[cursor] == '"' {
            return cursor + 1;
        }
        cursor += 1;
    }
    cursor
}

fn consume_tick(chars: &[char], index: usize) -> usize {
    let Some(next) = chars.get(index + 1).copied() else {
        return index + 1;
    };
    if next == '\\' {
        let mut cursor = index + 2;
        if chars.get(cursor) == Some(&'u') && chars.get(cursor + 1) == Some(&'{') {
            while cursor < chars.len() && chars[cursor] != '}' {
                cursor += 1;
            }
            cursor = (cursor + 1).min(chars.len());
        } else if chars.get(cursor) == Some(&'x') {
            cursor = (cursor + 3).min(chars.len());
        } else {
            cursor = (cursor + 1).min(chars.len());
        }
        if chars.get(cursor) == Some(&'\'') {
            cursor += 1;
        }
        return cursor;
    }
    if next == '_' || next.is_ascii_alphabetic() {
        let mut cursor = index + 2;
        while cursor < chars.len()
            && (chars[cursor] == '_' || chars[cursor].is_ascii_alphanumeric())
        {
            cursor += 1;
        }
        if cursor == index + 2 && chars.get(cursor) == Some(&'\'') {
            return cursor + 1;
        }
        return cursor;
    }
    if chars.get(index + 2) == Some(&'\'') {
        return index + 3;
    }
    index + 1
}
