#define MyAppName "Pole Scoring"
#ifndef SourceDir
  #define SourceDir "..\\dist\\pole-scoring"
#endif
#ifndef OutputDir
  #define OutputDir "..\\dist\\installer"
#endif

[Setup]
AppId={{5E7C1B3A-2F6D-4E9A-9C3B-7A1D2F4E8B60}
AppName={#MyAppName}
AppVersion=0.1.0
DefaultDirName={autopf}\PoleScoringLocal
DefaultGroupName=Pole Scoring
OutputDir={#OutputDir}
OutputBaseFilename=pole-scoring-setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#SourcePath}\pole-scoring.ico

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#SourcePath}\pole-scoring.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Pole Scoring"; Filename: "{app}\pole-scoring.exe"; IconFilename: "{app}\pole-scoring.ico"
Name: "{autodesktop}\Pole Scoring"; Filename: "{app}\pole-scoring.exe"; IconFilename: "{app}\pole-scoring.ico"

[Run]
Filename: "{app}\pole-scoring.exe"; Description: "Lancer Pole Scoring"; Flags: nowait postinstall skipifsilent
