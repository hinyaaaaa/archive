Set shell = CreateObject("WScript.Shell")
Set shortcut = shell.CreateShortcut("C:\Users\coela\OneDrive\デスクトップ\Ankel.lnk")
shortcut.TargetPath = "D:\Ankel\起動.bat"
shortcut.IconLocation = "D:\Ankel\ankel.ico, 0"
shortcut.WindowStyle = 1
shortcut.Description = "Ankel"
shortcut.Save()
MsgBox "Done"