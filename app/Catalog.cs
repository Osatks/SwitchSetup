/* Copyright (c) 2019 noahc3 (original Homebrew SD Setup)
 * Copyright (c) 2026 SwitchSetup contributors
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
using System.Reflection;
using System.Text.Json;

namespace SwitchSetup;

public record Catalog(int Version, List<Category> Categories, List<Preset> Presets, List<PackageDef> Packages, SupportInfo? Support = null);

/// <summary>Donation links shown in the app. A link with an empty url is shown as "coming soon".</summary>
public record SupportInfo(string Message, List<SupportLink> Links);

public record SupportLink(string Name, string? Description, string? Url);

public record Category(string Id, string Name);

public record Preset(string Id, string Name, string Description, List<string> Packages);

public record PackageDef(
    string Id,
    string Name,
    string Category,
    string? Authors,
    string? Description,
    string? Repo,
    bool Required = false,
    string? Warning = null,
    List<string>? Dependencies = null,
    List<AssetRule>? Assets = null,
    List<GeneratedFile>? Files = null,
    List<string>? KeepExisting = null);

/// <summary>How to install one GitHub release asset.</summary>
/// <param name="Match">Regex matched against the asset file name.</param>
/// <param name="Action">"extract" a zip into the SD root (or <see cref="To"/>[0]), or "copy" the file to each path in <see cref="To"/>.</param>
/// <param name="Exclude">Regex of zip entry paths to skip when extracting.</param>
/// <param name="Strip">Folder inside the zip that holds the SD card files (e.g. "SdOut/"); entries outside it are skipped.</param>
public record AssetRule(string Match, string Action, List<string>? To = null, string? Exclude = null, string? Strip = null);

public record GeneratedFile(string Path, string Content);

// PackageDef.KeepExisting: regexes of paths (usually user-edited settings files such as
// config/sys-con/config.ini) that are only written when the card doesn't have them yet.
// Everything else is always overwritten with the new version.

public record PackageVersion(string Id, string? Version, DateTimeOffset? PublishedAt, string? Url, long Size, string? Error);

public record EjectRequest(string Drive);

public class CatalogStore {
    static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true, ReadCommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };

    /// <summary>
    /// A catalog.json next to the executable overrides the built-in one, so packages
    /// can be added or fixed without rebuilding the app.
    /// </summary>
    public static string OverridePath => Path.Combine(AppContext.BaseDirectory, "catalog.json");

    public Catalog Load() {
        string text;
        if (File.Exists(OverridePath)) {
            text = File.ReadAllText(OverridePath);
        } else {
            using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("catalog.json")!;
            using var r = new StreamReader(s);
            text = r.ReadToEnd();
        }
        return JsonSerializer.Deserialize<Catalog>(text, Json) ?? throw new InvalidDataException("catalog.json is empty");
    }
}
