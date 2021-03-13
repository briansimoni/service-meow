# fqdn - this is used for the 'issued to' and 'issued by' field of the certificate
# pwd - password for exporting the certificate private key
# location - path to folder where both the pfx and cer file will be written to, for example C:\users\john\Documents
#
# Taken from https://blogs.aaddevsup.xyz/2020/08/using-powershell-to-configure-a-signing-certificate-for-a-saml-based-sso-enterprise-application/
 
Param(
    [Parameter(Mandatory=$true)]
    [string]$fqdn,
    [Parameter(Mandatory=$true)]
    [string]$pwd,
    [Parameter(Mandatory=$true)]
    [string]$location
) 
 
if (!$PSBoundParameters.ContainsKey('location'))
{
    $location = "."
} 
 
$cert = New-SelfSignedCertificate -certstorelocation cert:\currentuser\my -DnsName $fqdn
$pwdSecure = ConvertTo-SecureString -String $pwd -Force -AsPlainText
$path = 'cert:\currentuser\my\' + $cert.Thumbprint
$cerFile = $location + "\\" + $fqdn + ".cer"
$pfxFile = $location + "\\" + $fqdn + ".pfx"
 
Export-PfxCertificate -cert $path -FilePath $pfxFile -Password $pwdSecure
Export-Certificate -cert $path -FilePath $cerFile