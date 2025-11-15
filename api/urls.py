import requests

url = "https://tiktok-scraper7.p.rapidapi.com/user/followers"

querystring = {"user_id": "7468848847311504390", "count": "200", "time": "0"}

headers = {
    "x-rapidapi-key": "f3dbe81fe5msh5f7554a137e41f1p11dce0jsnabd433c62319",
    "x-rapidapi-host": "tiktok-scraper7.p.rapidapi.com"
}

response = requests.get(url, headers=headers, params=querystring)
data = response.json()

# Verifica se veio lista de seguidores
followers = data.get("data", {}).get("followers", [])

urls = []

for f in followers:
    unique_id = f.get("unique_id")
    if unique_id:
        url_tiktok = f"https://www.tiktok.com/@{unique_id}"
        urls.append(url_tiktok)

# Salvar no arquivo urls.txt
with open("urls.txt", "w", encoding="utf-8") as file:
    for u in urls:
        file.write(u + "\n")

print(f"{len(urls)} URLs salvas em urls.txt")
