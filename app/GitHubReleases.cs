/* Copyright (c) 2019 noahc3 (original Homebrew SD Setup)
 * Copyright (c) 2026 SwitchSetup contributors
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SwitchSetup;

public record GhAsset(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("size")] long Size,
    [property: JsonPropertyName("browser_download_url")] string DownloadUrl);

public record GhRelease(
    [property: JsonPropertyName("tag_name")] string TagName,
    [property: JsonPropertyName("html_url")] string HtmlUrl,
    [property: JsonPropertyName("published_at")] DateTimeOffset? PublishedAt,
    [property: JsonPropertyName("assets")] List<GhAsset> Assets);

/// <summary>
/// Fetches latest releases straight from each project's GitHub page and caches
/// both the release metadata and the downloaded files, so repeated builds are
/// fast and do not burn through GitHub's 60 requests/hour anonymous limit.
/// Set the GITHUB_TOKEN environment variable to raise the limit to 5000/hour.
/// </summary>
public class GitHubReleases {
    static readonly TimeSpan MetadataTtl = TimeSpan.FromMinutes(30);

    readonly HttpClient http;
    readonly ConcurrentDictionary<string, (DateTime fetched, GhRelease release)> cache = new();
    readonly string cacheDir;
    readonly string metadataFile;
    readonly SemaphoreSlim fileLock = new(1, 1);

    public GitHubReleases() {
        http = new HttpClient(new HttpClientHandler { AutomaticDecompression = DecompressionMethods.All });
        http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("SwitchSetup", "2.1"));
        http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        var token = Environment.GetEnvironmentVariable("GITHUB_TOKEN");
        if (!string.IsNullOrWhiteSpace(token)) http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        cacheDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SwitchSetup", "cache");
        Directory.CreateDirectory(cacheDir);
        metadataFile = Path.Combine(cacheDir, "releases.json");
        try {
            if (File.Exists(metadataFile)) {
                var saved = JsonSerializer.Deserialize<Dictionary<string, SavedRelease>>(File.ReadAllText(metadataFile));
                if (saved != null) foreach (var (k, v) in saved) cache[k] = (v.Fetched, v.Release);
            }
        } catch { /* a corrupt cache is not fatal */ }
    }

    record SavedRelease(DateTime Fetched, GhRelease Release);

    public void ClearCache() => cache.Clear();

    public async Task<GhRelease> GetLatestAsync(string repo) {
        if (cache.TryGetValue(repo, out var hit) && DateTime.UtcNow - hit.fetched < MetadataTtl) return hit.release;

        using var resp = await http.GetAsync($"https://api.github.com/repos/{repo}/releases/latest");
        if (!resp.IsSuccessStatusCode) {
            // Fall back to stale cached data rather than failing outright (e.g. rate limited / offline)
            if (hit.release != null) return hit.release;
            if (resp.StatusCode == HttpStatusCode.Forbidden || (int)resp.StatusCode == 429)
                throw new HttpRequestException("GitHub rate limit reached. Wait an hour or set the GITHUB_TOKEN environment variable.");
            throw new HttpRequestException($"GitHub returned {(int)resp.StatusCode} for {repo}");
        }
        var release = (await resp.Content.ReadFromJsonAsync<GhRelease>())!;
        cache[repo] = (DateTime.UtcNow, release);
        await SaveMetadataAsync();
        return release;
    }

    async Task SaveMetadataAsync() {
        await fileLock.WaitAsync();
        try {
            var data = cache.ToDictionary(kv => kv.Key, kv => new SavedRelease(kv.Value.fetched, kv.Value.release));
            await File.WriteAllTextAsync(metadataFile, JsonSerializer.Serialize(data));
        } catch { } finally { fileLock.Release(); }
    }

    /// <summary>Returns a local path to the asset, downloading it if it is not cached yet.</summary>
    public async Task<string> DownloadAsync(GhAsset asset, Action<string> log, CancellationToken ct = default) {
        var dir = Path.Combine(cacheDir, asset.Id.ToString());
        var path = Path.Combine(dir, Path.GetFileName(asset.Name));
        if (File.Exists(path) && new FileInfo(path).Length == asset.Size) {
            log($"  using cached {asset.Name}");
            return path;
        }
        Directory.CreateDirectory(dir);
        log($"  downloading {asset.Name} ({asset.Size / 1024.0 / 1024.0:0.0} MB)");
        var tmp = path + ".part";
        using (var resp = await http.GetAsync(asset.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, ct)) {
            resp.EnsureSuccessStatusCode();
            await using var fs = File.Create(tmp);
            await resp.Content.CopyToAsync(fs, ct);
        }
        File.Move(tmp, path, true);
        return path;
    }
}
