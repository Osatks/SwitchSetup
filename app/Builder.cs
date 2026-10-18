/* Copyright (c) 2019 noahc3 (original Homebrew SD Setup)
 * Copyright (c) 2026 SwitchSetup contributors
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
using System.Collections.Concurrent;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SwitchSetup;

/// <param name="CleanUpdate">Drive target only: back up and remove old Atmosphère/Hekate files first.</param>
public record BuildRequest(List<string> Packages, string Target, string? Drive, bool CleanUpdate = false);

/// <summary>Destination for SD card files: either a ZIP archive or a drive root.</summary>
interface ISdOutput : IDisposable {
    void Write(string relPath, Stream content);
    int FileCount { get; }
}

/// <summary>
/// Stages files in a temp folder (so later packages can overwrite earlier ones, just
/// like on a real SD card) and zips the folder once all packages are written.
/// </summary>
sealed class ZipOutput : ISdOutput {
    readonly string zipPath;
    readonly string staging;
    readonly DirectoryOutput dir;
    public int FileCount => Directory.EnumerateFiles(staging, "*", SearchOption.AllDirectories).Count();

    public ZipOutput(string zipPath) {
        this.zipPath = zipPath;
        staging = zipPath + ".staging";
        Directory.CreateDirectory(staging);
        dir = new DirectoryOutput(staging);
    }

    public void Write(string relPath, Stream content) => dir.Write(relPath, content);

    public void Complete() {
        if (File.Exists(zipPath)) File.Delete(zipPath);
        ZipFile.CreateFromDirectory(staging, zipPath, CompressionLevel.Optimal, false);
    }

    public void Dispose() {
        try { Directory.Delete(staging, true); } catch { }
    }
}

sealed class DirectoryOutput : ISdOutput {
    readonly string root;
    public int FileCount { get; private set; }
    public DirectoryOutput(string root) { this.root = root; }

    /// <summary>Writes a file, always replacing whatever already has that name.</summary>
    public void Write(string relPath, Stream content) {
        var rootFull = Path.GetFullPath(root);
        var full = Path.GetFullPath(Path.Combine(root, relPath));
        if (!full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"Refusing to write outside the SD card: {relPath}");

        // A *file* sitting where a folder needs to go (e.g. a stray file called "switch"): replace it.
        var dir = Path.GetDirectoryName(full)!;
        for (var d = dir; d.Length > rootFull.Length; d = Path.GetDirectoryName(d)!) {
            if (File.Exists(d)) {
                File.SetAttributes(d, FileAttributes.Normal);
                File.Delete(d);
            }
        }
        Directory.CreateDirectory(dir);

        if (Directory.Exists(full))
            throw new IOException($"There is a folder named \"{relPath}\" on the card where a file needs to go. Rename or delete that folder and try again.");
        if (File.Exists(full)) File.SetAttributes(full, FileAttributes.Normal); // read-only/hidden files would block overwrite
        using var fs = new FileStream(full, FileMode.Create, FileAccess.Write, FileShare.None);
        content.CopyTo(fs);
        FileCount++;
    }

    public void Dispose() { }
}

public class Job {
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public string Status { get; set; } = "running"; // running | done | error
    public string Phase { get; set; } = "Starting";
    public double Progress { get; set; }
    public string? Error { get; set; }
    public string? ZipPath { get; set; }
    public string? BackupPath { get; set; }
    public string Target { get; init; } = "zip";
    public string? Drive { get; init; }
    public long Bytes { get; set; }
    public List<string> Installed { get; } = new();
    readonly List<string> log = new();

    public void Log(string line) { lock (log) log.Add(line); }

    public object Snapshot() {
        lock (log) return new { Id, Status, Phase, Progress, Error, Target, Drive, Installed, BackupPath, Bytes, Log = log.ToArray(), HasZip = ZipPath != null };
    }
}

public class JobManager {
    readonly ConcurrentDictionary<string, Job> jobs = new();
    readonly CatalogStore store;
    readonly GitHubReleases gh;
    readonly string outDir = Path.Combine(Path.GetTempPath(), "SwitchSetup");

    public JobManager(CatalogStore store, GitHubReleases gh) {
        this.store = store;
        this.gh = gh;
        Directory.CreateDirectory(outDir);
    }

    public Job? Get(string id) => jobs.GetValueOrDefault(id);

    public Job Start(BuildRequest req) {
        var catalog = store.Load();
        var byId = catalog.Packages.ToDictionary(p => p.Id);

        if (req.Target != "zip" && req.Target != "drive") throw new ArgumentException("Target must be 'zip' or 'drive'");
        if (req.Target == "drive" && !DriveTools.IsRemovable(req.Drive))
            throw new ArgumentException("The selected SD card was not found. Re-insert it and try again.");
        if (jobs.Values.Any(j => j.Status == "running"))
            throw new ArgumentException("A build is already running. Wait for it to finish.");

        var selected = ResolveDependencies(req.Packages, byId, catalog);
        if (selected.Count == 0) throw new ArgumentException("No packages selected");

        var job = new Job { Target = req.Target, Drive = req.Drive };
        jobs[job.Id] = job;
        _ = Task.Run(() => RunAsync(job, selected, req));
        return job;
    }

    /// <summary>Adds required packages and dependencies, keeping catalog order so install order is predictable.</summary>
    public static List<PackageDef> ResolveDependencies(List<string> ids, Dictionary<string, PackageDef> byId, Catalog catalog) {
        var want = new HashSet<string>(ids.Where(byId.ContainsKey));
        foreach (var p in catalog.Packages.Where(p => p.Required)) want.Add(p.Id);
        var queue = new Queue<string>(want);
        while (queue.Count > 0) {
            foreach (var dep in byId[queue.Dequeue()].Dependencies ?? new())
                if (byId.ContainsKey(dep) && want.Add(dep)) queue.Enqueue(dep);
        }
        return catalog.Packages.Where(p => want.Contains(p.Id)).ToList();
    }

    /// <summary>A package with its release resolved and every file downloaded, ready to write.</summary>
    record Prepared(PackageDef Package, string? Version, List<(AssetRule Rule, GhAsset Asset, string LocalPath)> Assets);

    async Task RunAsync(Job job, List<PackageDef> packages, BuildRequest req) {
        string? zipPath = null;
        try {
            // Phase 1: download everything first, so a network problem can never leave a half-written SD card.
            job.Phase = "Downloading";
            job.Log($"Downloading {packages.Count} packages from GitHub");
            var prepared = new List<Prepared>();
            for (int i = 0; i < packages.Count; i++) {
                var p = packages[i];
                job.Progress = 0.6 * i / packages.Count;
                job.Log($"[{i + 1}/{packages.Count}] {p.Name}");
                prepared.Add(await PrepareAsync(p, job.Log));
            }

            // Phase 2 (drive only): optional clean update.
            if (req.Target == "drive" && req.CleanUpdate) {
                job.Phase = "Cleaning old files";
                job.Progress = 0.62;
                job.Log("Clean update");
                job.BackupPath = DriveTools.CleanForUpdate(req.Drive!, job.Log);
            }

            // Phase 3: write.
            job.Phase = req.Target == "zip" ? "Building ZIP" : "Writing to SD card";
            job.Log(req.Target == "zip" ? "Building ZIP" : $"Writing to {req.Drive}");
            ISdOutput output;
            if (req.Target == "zip") {
                zipPath = Path.Combine(outDir, job.Id + ".zip");
                output = new ZipOutput(zipPath);
            } else {
                output = new DirectoryOutput(req.Drive!);
            }

            using (output) {
                for (int i = 0; i < prepared.Count; i++) {
                    job.Progress = 0.65 + 0.3 * i / prepared.Count;
                    Apply(prepared[i], output);
                    var v = prepared[i].Version;
                    job.Installed.Add(v is null ? prepared[i].Package.Name : $"{prepared[i].Package.Name} {v}");
                }
                WriteRecord(prepared, output);
                job.Log($"Wrote {output.FileCount} files");
                if (output is ZipOutput z) {
                    job.Phase = "Compressing";
                    job.Log("Compressing ZIP…");
                    z.Complete();
                }
            }

            if (zipPath != null) {
                job.ZipPath = zipPath;
                job.Bytes = new FileInfo(zipPath).Length;
            }
            job.Progress = 1;
            job.Phase = "Done";
            job.Status = "done";
            job.Log("Done!");
        } catch (Exception e) {
            job.Error = e.Message;
            if (job.BackupPath != null) job.Error += $" Your previous files are backed up at {job.BackupPath}.";
            job.Status = "error";
            job.Log("ERROR: " + e.Message);
            if (zipPath != null) try { File.Delete(zipPath); } catch { }
        }
    }

    /// <summary>
    /// switchsetup.json lets the app show what's installed and what has updates next time
    /// the card is inserted. switchsetup.txt is the same information for humans.
    /// </summary>
    static void WriteRecord(List<Prepared> prepared, ISdOutput output) {
        var record = new InstallRecord(DateTime.Now, prepared.ToDictionary(p => p.Package.Id, p => p.Version ?? "bundled"));
        output.Write(DriveTools.RecordFile, new MemoryStream(JsonSerializer.SerializeToUtf8Bytes(record, new JsonSerializerOptions { WriteIndented = true })));

        var txt = new StringBuilder()
            .AppendLine($"Created with SwitchSetup on {DateTime.Now:yyyy-MM-dd HH:mm}")
            .AppendLine("Based on Homebrew SD Setup by noahc3.")
            .AppendLine();
        foreach (var p in prepared) txt.AppendLine($"{p.Package.Name}: {p.Version ?? "bundled"}");
        output.Write("switchsetup.txt", new MemoryStream(Encoding.UTF8.GetBytes(txt.ToString())));
    }

    async Task<Prepared> PrepareAsync(PackageDef p, Action<string> log) {
        var assets = new List<(AssetRule, GhAsset, string)>();
        string? version = null;
        if (p.Repo != null && p.Assets is { Count: > 0 }) {
            var release = await gh.GetLatestAsync(p.Repo);
            version = release.TagName;
            log($"  version {release.TagName}");
            foreach (var rule in p.Assets) {
                var asset = MatchAsset(release, rule)
                    ?? throw new InvalidDataException($"{p.Name} {release.TagName}: no release file matches '{rule.Match}'. The project may have renamed its files; update catalog.json.");
                assets.Add((rule, asset, await gh.DownloadAsync(asset, log)));
            }
        }
        return new Prepared(p, version, assets);
    }

    public static GhAsset? MatchAsset(GhRelease release, AssetRule rule) {
        var re = new Regex(rule.Match, RegexOptions.IgnoreCase);
        return release.Assets.FirstOrDefault(a => re.IsMatch(a.Name));
    }

    static void Apply(Prepared prep, ISdOutput output) {
        foreach (var (rule, asset, local) in prep.Assets) {
            if (rule.Action == "extract") {
                ExtractZip(local, rule.To?.FirstOrDefault() ?? "", rule.Exclude, output);
            } else if (rule.Action == "copy") {
                foreach (var dest in rule.To ?? new() { asset.Name }) {
                    using var fs = File.OpenRead(local);
                    output.Write(Normalize(dest), fs);
                }
            } else {
                throw new InvalidDataException($"Unknown action '{rule.Action}' in {prep.Package.Id}");
            }
        }
        foreach (var f in prep.Package.Files ?? new()) {
            output.Write(Normalize(f.Path), new MemoryStream(Encoding.UTF8.GetBytes(f.Content.Replace("\r\n", "\n"))));
        }
    }

    static void ExtractZip(string zipPath, string prefix, string? exclude, ISdOutput output) {
        var ex = exclude is null ? null : new Regex(exclude, RegexOptions.IgnoreCase);
        using var zip = ZipFile.OpenRead(zipPath);
        foreach (var entry in zip.Entries) {
            if (entry.FullName.EndsWith('/') || entry.FullName.EndsWith('\\')) continue; // directory
            if (ex != null && ex.IsMatch(entry.FullName)) continue;
            using var s = entry.Open();
            output.Write(Normalize(Path.Combine(prefix, entry.FullName)), s);
        }
    }

    /// <summary>Forward slashes, no leading slash, and no ".." so archives can't escape the SD root (zip-slip).</summary>
    static string Normalize(string path) {
        var parts = path.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Any(x => x == "..")) throw new InvalidDataException($"Unsafe path in package: {path}");
        return string.Join('/', parts);
    }
}
