/* Copyright (c) 2019 noahc3 (original Homebrew SD Setup)
 * Copyright (c) 2026 SwitchSetup contributors
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
using System.Diagnostics;
using System.IO.Compression;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SwitchSetup;

/// <summary>What is already on a card, so the UI can show "update available".</summary>
/// <param name="Installed">Package id → version, from switchsetup.json written by a previous build.</param>
/// <param name="UsedInConsole">A Nintendo folder exists, i.e. the card has been in a Switch.</param>
public record CardInfo(Dictionary<string, string> Installed, bool HasAtmosphere, bool HasHekate, bool HasEmummc, bool UsedInConsole, DateTime? LastBuilt);

public record DriveEntry(string Root, string Label, string Format, double TotalGb, double FreeGb, CardInfo Card);

public record InstallRecord(DateTime Built, Dictionary<string, string> Packages);

public static class DriveTools {
    public const string RecordFile = "switchsetup.json";

    /// <summary>Only removable drives are offered, so the app can never write to C: or an internal disk.</summary>
    public static List<DriveEntry> ListRemovable() {
        var list = DriveInfo.GetDrives()
            .Where(d => d.DriveType == DriveType.Removable && d.IsReady)
            .Select(d => new DriveEntry(d.RootDirectory.FullName, d.VolumeLabel, d.DriveFormat,
                Math.Round(d.TotalSize / 1e9, 1), Math.Round(d.AvailableFreeSpace / 1e9, 1), Inspect(d.RootDirectory.FullName)))
            .ToList();
        // Development only: SWITCHSETUP_TEST_CARD=<folder> shows that folder as a fake SD card.
        var test = Environment.GetEnvironmentVariable("SWITCHSETUP_TEST_CARD");
        if (!string.IsNullOrWhiteSpace(test) && Directory.Exists(test)) {
            var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(test)) + Path.DirectorySeparatorChar;
            list.Add(new DriveEntry(root, "TEST CARD", "FAT32", 32, 30, Inspect(root)));
        }
        return list;
    }

    public static bool IsRemovable(string? root) =>
        !string.IsNullOrEmpty(root) && ListRemovable().Any(d => d.Root.Equals(root, StringComparison.OrdinalIgnoreCase));

    static CardInfo Inspect(string root) {
        var installed = new Dictionary<string, string>();
        DateTime? built = null;
        try {
            var rec = Path.Combine(root, RecordFile);
            if (File.Exists(rec)) {
                var r = JsonSerializer.Deserialize<InstallRecord>(File.ReadAllText(rec));
                if (r != null) { installed = r.Packages; built = r.Built; }
            }
        } catch { /* unreadable record: treat as unknown */ }
        return new CardInfo(installed,
            File.Exists(Path.Combine(root, "atmosphere", "package3")),
            File.Exists(Path.Combine(root, "bootloader", "sys", "nyx.bin")),
            Directory.Exists(Path.Combine(root, "emuMMC")),
            Directory.Exists(Path.Combine(root, "Nintendo")),
            built);
    }

    /// <summary>Safely ejects the card using the Windows shell, same as "Eject" in File Explorer.</summary>
    public static bool Eject(string root) {
        if (!IsRemovable(root) || !Regex.IsMatch(root, @"^[A-Za-z]:\\$")) return false;
        var letter = root.Substring(0, 2);
        var psi = new ProcessStartInfo("powershell.exe",
            $"-NoProfile -NonInteractive -Command \"(New-Object -ComObject Shell.Application).Namespace(17).ParseName('{letter}').InvokeVerb('Eject')\"") {
            CreateNoWindow = true, UseShellExecute = false
        };
        using var p = Process.Start(psi);
        p?.WaitForExit(15000);
        Thread.Sleep(1500);
        return !Directory.Exists(root);
    }

    public static string BackupDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "SwitchSetup Backups");

    /// <summary>
    /// Clean update, as recommended by switch.hacks.guide: back up atmosphere/ and bootloader/
    /// to the PC, then remove old Atmosphère/Hekate system files so stale files can't break boot.
    /// Kept on the card: atmosphere/contents (mods and sysmodules), bootloader/ini and bootloader/payloads.
    /// emuMMC, Nintendo, saves and everything else is never touched.
    /// </summary>
    public static string? CleanForUpdate(string root, Action<string> log) {
        var atmo = Path.Combine(root, "atmosphere");
        var boot = Path.Combine(root, "bootloader");
        if (!Directory.Exists(atmo) && !Directory.Exists(boot)) {
            log("  nothing to clean (fresh card)");
            return null;
        }

        Directory.CreateDirectory(BackupDir);
        var zipPath = Path.Combine(BackupDir, $"backup-{DateTime.Now:yyyy-MM-dd_HH-mm-ss}.zip");
        log($"  backing up atmosphere/ and bootloader/ to {zipPath}");
        using (var zip = ZipFile.Open(zipPath, ZipArchiveMode.Create)) {
            foreach (var dir in new[] { atmo, boot }.Where(Directory.Exists)) {
                foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)) {
                    zip.CreateEntryFromFile(f, Path.GetRelativePath(root, f).Replace('\\', '/'), CompressionLevel.Fastest);
                }
            }
        }

        if (Directory.Exists(atmo)) {
            foreach (var entry in Directory.EnumerateFileSystemEntries(atmo)) {
                if (Path.GetFileName(entry).Equals("contents", StringComparison.OrdinalIgnoreCase)) continue;
                DeleteEntry(entry);
            }
            log("  removed old Atmosphère files (kept atmosphere/contents)");
        }
        foreach (var sub in new[] { "sys", "res" }) {
            var p = Path.Combine(boot, sub);
            if (Directory.Exists(p)) DeleteEntry(p);
        }
        if (Directory.Exists(boot)) log("  removed old Hekate system files (kept ini/ and payloads/)");
        return zipPath;
    }

    static void DeleteEntry(string path) {
        if (Directory.Exists(path)) {
            // Cards used on a Mac or with archive-bit issues can have read-only attributes set.
            foreach (var f in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories)) File.SetAttributes(f, FileAttributes.Normal);
            Directory.Delete(path, true);
        } else {
            File.SetAttributes(path, FileAttributes.Normal);
            File.Delete(path);
        }
    }
}
