# Third-Party Notices

Cert Prep is licensed under the MIT License. Before a public Alpha is released,
redistributed runtime archives and installers must include machine-generated
SBOMs and the license texts required by their bundled dependencies. A release
remains blocked while a redistributed component has unknown or unapproved
terms.

## Qwen 3.5

Qwen 3.5 models are downloaded by the selected local runtime and are not
bundled in Cert Prep installers. The Qwen3.5-4B model is provided under the
Apache License 2.0:
https://huggingface.co/Qwen/Qwen3.5-4B/blob/main/LICENSE

## Speech recognition models

Speech recognition models are downloaded by Capture Runtime only after explicit
user consent and are not bundled in Cert Prep installers. TEA-ASR-1.1 (CUDA) and
its CPU fallback TEA-ASR-1.1-mini are provided under the MIT License and the
Apache License 2.0. They build on Qwen3-ASR, and word timing uses
Qwen3-ForcedAligner; both are provided under the Apache License 2.0:

- https://huggingface.co/JacobLinCool/TEA-ASR-1.1
- https://huggingface.co/JacobLinCool/TEA-ASR-1.1-mini
- https://huggingface.co/Qwen/Qwen3-ASR-1.7B-hf
- https://huggingface.co/Qwen/Qwen3-ASR-0.6B-hf
- https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B-hf

## WindowsML OCR payload

The downloadable OCR runtime contains PP-OCRv6 medium detection and recognition
model payloads derived from the official PaddleOCR/PaddleX release sources.
The release inventory records each ONNX model, config, dictionary, and pipeline
file with its own SHA-256. PaddleOCR v3.7.0 and PaddleX v3.7.1 are provided
under the Apache License 2.0:

- https://github.com/PaddlePaddle/PaddleOCR/blob/v3.7.0/LICENSE
- https://github.com/PaddlePaddle/PaddleX/blob/v3.7.1/LICENSE

## PyInstaller bootloader

The backend and OCR executables include the PyInstaller v6.20.0 bootloader.
Its GPL-2.0-or-later license includes the PyInstaller bootloader exception that
permits distribution of the produced executable; the complete pinned COPYING
text is included in release license inventory:
https://github.com/pyinstaller/pyinstaller/blob/v6.20.0/COPYING.txt

## SudachiPy 與 SudachiDict

漢字讀音解答使用隨後端封裝的 SudachiPy（原生擴充與資源）及
SudachiDict Core（詞典資料）。兩者由 Works Applications 提供，採用
Apache License 2.0；版本由後端的鎖檔記錄，完整授權文字來源如下：

- SudachiPy：https://github.com/WorksApplications/sudachi.rs/blob/develop/LICENSE
- SudachiDict：https://github.com/WorksApplications/SudachiDict/blob/develop/LICENSE-2.0.txt
- SudachiDict LEGAL：https://github.com/WorksApplications/SudachiDict/blob/develop/LEGAL

SudachiDict 的 LEGAL 另列出 UniDic（Copyright (c) 2011–2013,
The UniDic Consortium）與 NEologd（Copyright (C) 2015–2019 Toshinori Sato）
及其資料來源：はてなキーワード、日本郵便郵遞區號資料、スナフキん的全國站名資料、
工藤拓提供的 Mozc 人名資料，以及依上述資源組合取得的網頁詞彙。
發行授權清單須包含上述 Apache 授權。以下保留上游 LEGAL 的完整原文，
含著作權、使用條件、免責聲明與來源參照：

```text
LEGAL NOTICE INFORMATION
========================

- All the files in this distribution are covered under the Apache License
version 2.0. (see the file LICENSE-2.0.txt)


- src/main/text/small_lex.csv contains a part
  of UniDic (https://unidic.ninjal.ac.jp/).
- src/main/text/matrix.def.zip is a part of UniDic.

Copyright (c) 2011-2013, The UniDic Consortium
All rights reserved.
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

 * Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

 * Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the
   distribution.
 * Neither the name of the UniDic Consortium nor the names of its
   contributors may be used to endorse or promote products derived
   from this software without specific prior written permission.
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

- src/main/text/core_lex.csv and src/main/text/notcore_lex.csv contain
a part of NEologd (https://github.com/neologd/mecab-unidic-neologd).

Copyright (C) 2015-2019 Toshinori Sato (@overlast)

      https://github.com/neologd/mecab-unidic-neologd

    i. 本データは、株式会社はてなが提供するはてなキーワード一覧ファイル
       中の表記、及び、読み仮名の大半を使用している。

       はてなキーワード一覧ファイルの著作権は、株式会社はてなにある。

       はてなキーワード一覧ファイルの使用条件に基づき、また、
       データ使用の許可を頂いたことに対する感謝の意を込めて、
       以下に株式会社はてなおよびはてなキーワードへの参照をURLで示す。
       株式会社はてな : http://hatenacorp.jp/information/outline

       はてなキーワード :
       http://developer.hatena.ne.jp/ja/documents/keyword/misc/catalog

   ii. 本データは、日本郵便株式会社が提供する郵便番号データ中の表記、
       及び、読み仮名を使用している。

       日本郵便株式会社は、郵便番号データに限っては著作権を主張しないと
       述べている。

       日本郵便株式会社の郵便番号データに対する感謝の意を込めて、
       以下に日本郵便株式会社および郵便番号データへの参照をURLで示す。

       日本郵便株式会社 :
         http://www.post.japanpost.jp/about/profile.html

       郵便番号データ :
         http://www.post.japanpost.jp/zipcode/dl/readme.html
  iii. 本データは、スナフキん氏が提供する日本全国駅名一覧中の表記、及び
       読み仮名を使用している。

       日本全国駅名一覧の著作権は、スナフキん氏にある。

       スナフキん氏は 「このデータを利用されるのは自由ですが、その際に
       不利益を被ったりした場合でも、スナフキんは一切責任は負えません
       ことをご承知おき下さい」と述べている。

       スナフキん氏に対する感謝の意を込めて、
       以下に日本全国駅名一覧のコーナーへの参照をURLで示す。

       日本全国駅名一覧のコーナー :
         http://www5a.biglobe.ne.jp/~harako/data/station.htm

   iv. 本データは、工藤拓氏が提供する人名(姓/名)エントリデータ中の、
       漢字表記の姓・名とそれに対応する読み仮名を使用している。
       人名(姓/名)エントリデータは被災者・安否不明者の人名の
       表記揺れ対策として、Mozcの人名辞書を活用できるという
       工藤氏の考えによって提供されている。

       工藤氏に対する感謝の意を込めて、
       以下にデータ本体と経緯が分かる情報への参照をURLで示す。

       人名(姓/名)エントリデータ :
         http://chasen.org/~taku/software/misc/personal_name.zip

       上記データが提供されることになった経緯
         http://togetter.com/li/111529

    v. 本データは、Web上からクロールした大量の文書データから抽出した
       表記とそれに対応する読み仮名のデータを含んでいる。

       抽出した表記とそれに対応する読み仮名の組は、上記の i. から iv.
       の言語資源の組み合わせによって得られる組のみを採録した。
       Web 上に文書データを公開して下さっている皆様に感謝いたします。

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Generated inventories

Release-specific component names, versions, licenses, checksums, and source
locations must be published beside each alpha as SPDX/CycloneDX SBOM artifacts.
