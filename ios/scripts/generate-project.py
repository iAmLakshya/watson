#!/usr/bin/env python3
"""Create a deterministic Xcode project without requiring a package manager."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
objects = {}

def ident(name):
    return hashlib.sha256(name.encode()).hexdigest()[:24].upper()

def quote(value):
    return json.dumps(str(value))

def add(key, isa, **fields):
    uid = ident(key)
    objects[uid] = dict(isa=isa, **fields)
    return uid

def raw(value):
    if isinstance(value, dict):
        return "{ " + " ".join(f"{key} = {raw(item)};" for key, item in value.items()) + " }"
    if isinstance(value, list):
        return "(" + ", ".join(raw(item) for item in value) + ")"
    if isinstance(value, str) and value.startswith("@"):
        return value[1:]
    return quote(value)

products = []
targets = []
groups = []
base = dict(SDKROOT="iphoneos", IPHONEOS_DEPLOYMENT_TARGET="17.0", SWIFT_VERSION="5.0", CLANG_ENABLE_MODULES="YES", CLANG_ENABLE_OBJC_ARC="YES", GCC_C_LANGUAGE_STANDARD="gnu17", ENABLE_STRICT_OBJC_MSGSEND="YES", TARGETED_DEVICE_FAMILY="1,2", CODE_SIGN_STYLE="Automatic", DEVELOPMENT_TEAM="", ARCHS="$(ARCHS_STANDARD)", SUPPORTED_PLATFORMS="iphoneos iphonesimulator", SWIFT_STRICT_CONCURRENCY="targeted")

def configs(name, settings):
    children = []
    for configuration in ["Debug", "Release"]:
        values = dict(settings)
        values.update(SWIFT_OPTIMIZATION_LEVEL="-Onone" if configuration == "Debug" else "-O", DEBUG_INFORMATION_FORMAT="dwarf" if configuration == "Debug" else "dwarf-with-dsym", SWIFT_ACTIVE_COMPILATION_CONDITIONS="DEBUG" if configuration == "Debug" else "", ENABLE_TESTABILITY="YES" if configuration == "Debug" else "NO")
        children.append("@" + add(f"{name}-{configuration}", "XCBuildConfiguration", name=configuration, buildSettings=values))
    return add(f"{name}-configlist", "XCConfigurationList", buildConfigurations=children, defaultConfigurationIsVisible="@0", defaultConfigurationName="Release")

app_id = ident("Watson-target")
for name, directory, extension, product_type in [("Watson", "Watson", "app", "com.apple.product-type.application"), ("WatsonTests", "WatsonTests", "xctest", "com.apple.product-type.bundle.unit-test"), ("WatsonUITests", "WatsonUITests", "xctest", "com.apple.product-type.bundle.ui-testing")]:
    sources = []
    resources = []
    children = []
    files = sorted((ROOT / directory).rglob("*.swift"))
    for file in files:
        path = file.relative_to(ROOT).as_posix()
        ref = add(path + "-ref", "PBXFileReference", lastKnownFileType="sourcecode.swift", path=path, sourceTree="SOURCE_ROOT")
        build = add(path + "-build", "PBXBuildFile", fileRef="@" + ref)
        sources.append("@" + build)
        children.append("@" + ref)
    if name == "Watson":
        for path, kind in [("Watson/Assets.xcassets", "folder.assetcatalog"), ("Watson/PrivacyInfo.xcprivacy", "text.xml")]:
            ref = add(path + "-ref", "PBXFileReference", lastKnownFileType=kind, path=path, sourceTree="SOURCE_ROOT")
            resources.append("@" + add(path + "-build", "PBXBuildFile", fileRef="@" + ref))
            children.append("@" + ref)
        ref = add("plist-ref", "PBXFileReference", lastKnownFileType="text.plist.xml", path="Watson/Info.plist", sourceTree="SOURCE_ROOT")
        children.append("@" + ref)
    groups.append("@" + add(name + "-group", "PBXGroup", name=name, children=children, sourceTree="<group>"))
    product = add(name + "-product", "PBXFileReference", explicitFileType="wrapper.application" if extension == "app" else "wrapper.cfbundle", path=f"{name}.{extension}", sourceTree="BUILT_PRODUCTS_DIR")
    products.append("@" + product)
    source_phase = add(name + "-sources", "PBXSourcesBuildPhase", buildActionMask="@2147483647", files=sources, runOnlyForDeploymentPostprocessing="@0")
    resource_phase = add(name + "-resources", "PBXResourcesBuildPhase", buildActionMask="@2147483647", files=resources, runOnlyForDeploymentPostprocessing="@0")
    framework_phase = add(name + "-frameworks", "PBXFrameworksBuildPhase", buildActionMask="@2147483647", files=[], runOnlyForDeploymentPostprocessing="@0")
    settings = dict(base, PRODUCT_NAME="$(TARGET_NAME)", PRODUCT_BUNDLE_IDENTIFIER="com.watson.assistant.mobile" + ("" if name == "Watson" else "." + name.lower()), CURRENT_PROJECT_VERSION="1", MARKETING_VERSION="0.1.0", GENERATE_INFOPLIST_FILE="NO" if name == "Watson" else "YES")
    dependencies = []
    if name == "Watson":
        settings.update(INFOPLIST_FILE="Watson/Info.plist", ASSETCATALOG_COMPILER_APPICON_NAME="AppIcon", ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME="AccentColor", LD_RUNPATH_SEARCH_PATHS="$(inherited) @executable_path/Frameworks")
    else:
        proxy = add(name + "-proxy", "PBXContainerItemProxy", containerPortal="@" + ident("project"), proxyType="@1", remoteGlobalIDString="@" + app_id, remoteInfo="Watson")
        dependencies.append("@" + add(name + "-dependency", "PBXTargetDependency", target="@" + app_id, targetProxy="@" + proxy))
        if name == "WatsonTests":
            settings.update(TEST_HOST="$(BUILT_PRODUCTS_DIR)/Watson.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/Watson", BUNDLE_LOADER="$(TEST_HOST)", LD_RUNPATH_SEARCH_PATHS="$(inherited) @executable_path/Frameworks @loader_path/Frameworks")
        else:
            settings.update(TEST_TARGET_NAME="Watson", LD_RUNPATH_SEARCH_PATHS="$(inherited) @executable_path/Frameworks @loader_path/Frameworks")
    target = add(name + "-target", "PBXNativeTarget", name=name, productName=name, productReference="@" + product, productType=product_type, buildConfigurationList="@" + configs(name, settings), buildPhases=["@" + source_phase, "@" + framework_phase, "@" + resource_phase], buildRules=[], dependencies=dependencies)
    targets.append("@" + target)

products_group = add("products-group", "PBXGroup", name="Products", children=products, sourceTree="<group>")
main = add("main-group", "PBXGroup", children=groups + ["@" + products_group], sourceTree="<group>")
add("project", "PBXProject", attributes=dict(LastUpgradeCheck="2610", LastSwiftUpdateCheck="2610", TargetAttributes={app_id: {"CreatedOnToolsVersion": "26.1"}, ident("WatsonTests-target"): {"CreatedOnToolsVersion": "26.1", "TestTargetID": "@" + app_id}, ident("WatsonUITests-target"): {"CreatedOnToolsVersion": "26.1", "TestTargetID": "@" + app_id}}), buildConfigurationList="@" + configs("project", base), compatibilityVersion="Xcode 14.0", developmentRegion="en", hasScannedForEncodings="@0", knownRegions=["en", "Base"], mainGroup="@" + main, productRefGroup="@" + products_group, projectDirPath="", projectRoot="", targets=targets)

project = ROOT / "Watson.xcodeproj"
project.mkdir(exist_ok=True)
content = "// !$*UTF8*$!\n{\narchiveVersion = 1;\nclasses = {};\nobjectVersion = 56;\nobjects = {\n"
for uid, fields in objects.items():
    content += uid + " = " + raw(fields) + ";\n"
content += "};\nrootObject = " + ident("project") + ";\n}\n"
(project / "project.pbxproj").write_text(content)
schemes = project / "xcshareddata/xcschemes"
schemes.mkdir(parents=True, exist_ok=True)
reference = lambda name: f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident(name + "-target")}" BuildableName="{name}.{"app" if name == "Watson" else "xctest"}" BlueprintName="{name}" ReferencedContainer="container:Watson.xcodeproj"/>'
scheme = f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2610" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{reference("Watson")}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{reference("WatsonTests")}</TestableReference><TestableReference skipped="NO">{reference("WatsonUITests")}</TestableReference></Testables></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{reference("Watson")}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugServiceExtension="internal"><BuildableProductRunnable runnableDebuggingMode="0">{reference("Watson")}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>'''
(schemes / "Watson.xcscheme").write_text(scheme)
print(f"Created {project} ({len(objects)} objects)")
