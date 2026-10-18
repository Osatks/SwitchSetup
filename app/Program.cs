/* Copyright (c) 2019 noahc3 (original Homebrew SD Setup)
 * Copyright (c) 2026 SwitchSetup contributors
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using SwitchSetup;

var port = 5175;
var openBrowser = true;
for (int i = 0; i < args.Length; i++) {
    if (args[i] == "--port" && i + 1 < args.Length) port = int.Parse(args[++i]);
    else if (args[i] == "--no-browser") openBrowser = false;
}

var builder = WebApplication.CreateBuilder(args);
builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);
builder.Services.AddSingleton<CatalogStore>();
builder.Services.AddSingleton<GitHubReleases>();
builder.Services.AddSingleton<JobManager>();
builder.WebHost.UseUrls($"http://127.0.0.1:{port}");

var app = builder.Build();

app.MapGet("/api/catalog", (CatalogStore store) => store.Load());

app.MapGet("/api/versions", async (CatalogStore store, GitHubReleases gh, bool? refresh) => {
    var catalog = store.Load();
    if (refresh == true) gh.ClearCache();
    var tasks = catalog.Packages.Where(p => !string.IsNullOrEmpty(p.Repo)).Select(async p => {
        try {
            var rel = await gh.GetLatestAsync(p.Repo!);
            var size = (p.Assets ?? new()).Sum(r => JobManager.MatchAsset(rel, r)?.Size ?? 0);
            return new PackageVersion(p.Id, rel.TagName, rel.PublishedAt, rel.HtmlUrl, size, null);
        } catch (Exception e) {
            return new PackageVersion(p.Id, null, null, null, 0, e.Message);
        }
    });
    return await Task.WhenAll(tasks);
});

app.MapGet("/api/drives", () => DriveTools.ListRemovable());

app.MapPost("/api/drives/eject", (EjectRequest req) =>
    DriveTools.Eject(req.Drive) ? Results.Ok() : Results.BadRequest(new { error = "Windows could not eject the card. Close any windows using it and try again." }));

app.MapPost("/api/backups/open", () => {
    Directory.CreateDirectory(DriveTools.BackupDir);
    Process.Start(new ProcessStartInfo(DriveTools.BackupDir) { UseShellExecute = true });
    return Results.Ok();
});

app.MapGet("/api/info", () => new {
    version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3),
    backupDir = DriveTools.BackupDir,
    hasToken = !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("GITHUB_TOKEN"))
});

app.MapPost("/api/jobs", (BuildRequest req, JobManager jobs) => {
    try {
        return Results.Ok(new { id = jobs.Start(req).Id });
    } catch (ArgumentException e) {
        return Results.BadRequest(new { error = e.Message });
    }
});

app.MapGet("/api/jobs/{id}", (string id, JobManager jobs) =>
    jobs.Get(id) is { } job ? Results.Ok(job.Snapshot()) : Results.NotFound());

app.MapGet("/api/jobs/{id}/download", (string id, JobManager jobs) => {
    var job = jobs.Get(id);
    if (job?.ZipPath is null || !File.Exists(job.ZipPath)) return Results.NotFound();
    var name = $"SDSetup-{DateTime.Now:yyyy-MM-dd}.zip";
    return Results.File(job.ZipPath, "application/zip", name);
});

// Embedded UI
var asm = Assembly.GetExecutingAssembly();
var mime = new Dictionary<string, string> {
    [".html"] = "text/html; charset=utf-8", [".js"] = "text/javascript; charset=utf-8",
    [".css"] = "text/css; charset=utf-8", [".svg"] = "image/svg+xml", [".ico"] = "image/x-icon", [".png"] = "image/png"
};
app.MapGet("/{**path}", (string? path) => {
    path = string.IsNullOrEmpty(path) ? "index.html" : path;
    var stream = asm.GetManifestResourceStream("web/" + path);
    if (stream is null) return Results.NotFound();
    return Results.Stream(stream, mime.GetValueOrDefault(Path.GetExtension(path), "application/octet-stream"));
});

var url = $"http://127.0.0.1:{port}/";
app.Lifetime.ApplicationStarted.Register(() => {
    Console.WriteLine("SwitchSetup is running (based on Homebrew SD Setup by noahc3).");
    Console.WriteLine($"Open {url} in your browser. Close this window to quit.");
    if (openBrowser) {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }
});

app.Run();
