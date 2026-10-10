using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Translator.Core.Loading;

namespace Translator.Core.IO;

internal sealed record AssemblyBlob(string FileName, string Symbol, ReadOnlyMemory<byte> Data, string Comment);

internal static class AssemblyBlobWriter
{
    public static void Write(
        string assemblyPath,
        string blobDirectory,
        string blobReferenceDirectory,
        IReadOnlyList<AssemblyBlob> blobs,
        params string[] headerLines)
    {
        Directory.CreateDirectory(blobDirectory);
        var expectedFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var assembly = new StringBuilder();
        var companion = new StringBuilder();
        foreach (var header in headerLines) assembly.AppendLine(header);
        BeginCompanion(companion, headerLines);
        // PE/COFF (Windows), Mach-O (macOS), and ELF (Linux) spell a read-only data section
        // differently in GNU-as syntax. The build always targets
        // whichever platform the translator itself runs on (there is no cross-compilation
        // support), so that's what this picks the section syntax from.
        assembly.AppendLine(OperatingSystem.IsWindows()
            ? ".section .rdata,\"dr\""
            : OperatingSystem.IsMacOS()
                ? ".section __TEXT,__const"
                : ".section .rodata,\"a\",@progbits");
        assembly.AppendLine();

        foreach (var blob in blobs)
        {
            var blobPath = Path.Combine(blobDirectory, blob.FileName);
            expectedFiles.Add(Path.GetFullPath(blobPath));
            FileOutput.WriteBytesIfChanged(blobPath, blob.Data.Span);
            var hash = ChecksumUtilities.Sha256Hex(blob.Data.Span);
            assembly.AppendLine($"// {blob.Comment}; sha256={hash}");
            assembly.AppendLine(".p2align 4");
            // C/C++ external symbols carry a leading underscore in Mach-O,
            // unlike ELF and COFF.  The generated C++ still names the symbol
            // without that ABI decoration, so emit the platform spelling here.
            var assemblySymbol = OperatingSystem.IsMacOS() ? $"_{blob.Symbol}" : blob.Symbol;
            assembly.AppendLine($".globl {assemblySymbol}");
            assembly.AppendLine($"{assemblySymbol}:");
            var referencePath = Path.Combine(blobReferenceDirectory, blob.FileName);
            assembly.AppendLine($".incbin \"{SanitizeAssemblyPath(referencePath)}\"");
            assembly.AppendLine();
            AppendCompanionBlob(companion, blob, hash, SanitizeAssemblyPath(referencePath));
        }
        EndCompanion(companion);

        foreach (var stalePath in Directory.EnumerateFiles(blobDirectory, "*.bin"))
        {
            if (!expectedFiles.Contains(Path.GetFullPath(stalePath))) File.Delete(stalePath);
        }
        if (!OperatingSystem.IsWindows() && !OperatingSystem.IsMacOS())
        {
            // Absence of a .note.GNU-stack section makes the linker assume the oldest, most
            // conservative default for this object (an executable stack) and warn about it; this
            // file has no code needing one, so mark it explicitly like every other GNU-as ELF
            // object linked into the binary already does (the norm on modern toolchains, just not
            // producible without an explicit section since this file is hand-assembled, not
            // compiler-emitted).
            assembly.AppendLine(".section .note.GNU-stack,\"\",@progbits");
        }
        FileOutput.WriteTextIfChanged(assemblyPath, assembly.ToString());
        FileOutput.WriteTextIfChanged(CompanionSourcePath(assemblyPath), companion.ToString());
    }

    /// <summary>
    /// Path of the C++ companion emitted next to a blob <c>.S</c>: same stem, <c>.cpp</c> extension.
    /// </summary>
    internal static string CompanionSourcePath(string assemblyPath) => Path.ChangeExtension(assemblyPath, ".cpp");

    /// <summary>
    /// True when <paramref name="sourcePath"/> is the C++ companion of a sibling blob <c>.S</c>.
    /// Native builds assemble the <c>.S</c>; compiling the companion as well would define every
    /// blob symbol twice, so source discovery must skip it (the web build picks the companion
    /// instead of the <c>.S</c>).
    /// </summary>
    internal static bool IsCompanionSource(string sourcePath) =>
        sourcePath.EndsWith(".cpp", StringComparison.OrdinalIgnoreCase) &&
        File.Exists(Path.ChangeExtension(sourcePath, ".S"));

    // The companion defines what the .S defines: one external-linkage C symbol per blob,
    // 16-byte aligned (.p2align 4), constant data (.rodata), filled from the same blob file. It is
    // for toolchains that cannot assemble GNU-as .S files (Emscripten/wasm) and relies on C23
    // #embed, which clang accepts in C++ as an extension. The .S stays the native source of truth.
    private static void BeginCompanion(StringBuilder cpp, string[] headerLines)
    {
        foreach (var header in headerLines) cpp.AppendLine(header);
        cpp.AppendLine("// C++ companion of the matching .S file, for toolchains that cannot assemble it");
        cpp.AppendLine("// (Emscripten/wasm). Defines the same symbols using #embed.");
        cpp.AppendLine("// Native builds use the .S; compile exactly one of the two, never both.");
        cpp.AppendLine("#include <cstdint>");
        cpp.AppendLine();
        cpp.AppendLine("#if !defined(__clang__) || !defined(__has_embed)");
        cpp.AppendLine("#error This file requires a clang with #embed support (clang 19 or newer).");
        cpp.AppendLine("#endif");
        cpp.AppendLine();
        cpp.AppendLine("#pragma clang diagnostic push");
        cpp.AppendLine("#pragma clang diagnostic ignored \"-Wc23-extensions\"");
        cpp.AppendLine();
        cpp.AppendLine("extern \"C\" {");
        cpp.AppendLine();
    }

    private static void AppendCompanionBlob(StringBuilder cpp, AssemblyBlob blob, string hash, string embedPath)
    {
        var literal = EscapeCppString(embedPath);
        cpp.AppendLine($"// {blob.Comment}; sha256={hash}");
        cpp.AppendLine($"#if !__has_embed(\"{literal}\")");
        cpp.AppendLine($"#error Missing blob file: {blob.FileName}");
        cpp.AppendLine("#endif");
        cpp.AppendLine($"alignas(16) extern const uint8_t {blob.Symbol}[] = {{");
        if (blob.Data.Length == 0)
        {
            // A zero-length array is ill-formed. The .S symbol for an empty blob is a bare label
            // that nothing reads, so one pad byte keeps the definition valid.
            cpp.AppendLine("    0");
        }
        else
        {
            cpp.AppendLine($"#embed \"{literal}\"");
        }
        cpp.AppendLine("};");
        cpp.AppendLine();
    }

    private static void EndCompanion(StringBuilder cpp)
    {
        cpp.AppendLine("} // extern \"C\"");
        cpp.AppendLine();
        cpp.AppendLine("#pragma clang diagnostic pop");
    }

    private static string EscapeCppString(string value) => value.Replace("\\", "\\\\").Replace("\"", "\\\"");

    private static string SanitizeAssemblyPath(string path) => Path.GetFullPath(path).Replace('\\', '/');
}
